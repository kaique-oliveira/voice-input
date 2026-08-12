//
//  VoxHelper: o único código nativo do Voice Input.
//
//  Existe porque três coisas no macOS não têm equivalente decente em Node:
//    1. capturar o microfone com latência baixa e sem manter um renderer vivo
//    2. postar um ⌘V sintético no app em foco
//    3. descobrir qual app está em foco sem disparar prompt de Automação
//
//  Protocolo: um comando por invocação, uma linha de JSON por evento no stdout.
//  Erros sempre viram {"event":"error","code":"...","message":"..."} + exit 1.
//
//  Uso:
//    vox-helper record <caminho.wav>   # grava até ler "stop" no stdin
//    vox-helper paste                  # cola o texto lido do stdin
//    vox-helper frontapp               # bundle id do app em foco
//    vox-helper status                 # permissões de microfone e acessibilidade
//    vox-helper request-accessibility  # abre o diálogo de Acessibilidade
//    vox-helper request-mic            # dispara o prompt de microfone
//

import AVFoundation
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Saída

/// Toda comunicação com o Electron passa por aqui: uma linha, um JSON.
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["event": "error", "code": code, "message": message])
    exit(1)
}

// MARK: - Gravação

/// Grava o microfone direto em WAV 16 kHz mono 16-bit, exatamente o formato que
/// o whisper.cpp quer, para não precisar de conversão depois.
final class Recorder {
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private let lock = NSLock()
    private var frames: Int64 = 0
    private var peak: Float = 0
    private var stopped = false

    /// Formato alvo do whisper.cpp. Não mude sem mudar o servidor junto.
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false
    )!

    func start(path: String) throws {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            fail("NO_INPUT_DEVICE", "Nenhum dispositivo de entrada de áudio disponível.")
        }

        // O arquivo é escrito como PCM 16-bit; entregamos buffers float32 e o
        // AVAudioFile faz a quantização.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        file = try AVAudioFile(
            forWriting: url, settings: settings,
            commonFormat: .pcmFormatFloat32, interleaved: false
        )

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            fail("ENGINE_FAIL", "Não foi possível converter \(inputFormat.sampleRate) Hz para 16 kHz.")
        }

        let ratio = targetFormat.sampleRate / inputFormat.sampleRate
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            guard let out = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: capacity)
            else { return }

            var consumed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, out.frameLength > 0 else { return }

            // Pico de amplitude: usado para detectar áudio vazio/mudo sem
            // precisar de um VAD de verdade.
            if let samples = out.floatChannelData?[0] {
                var localPeak: Float = 0
                for i in 0..<Int(out.frameLength) {
                    let v = abs(samples[i])
                    if v > localPeak { localPeak = v }
                }
                self.lock.lock()
                if localPeak > self.peak { self.peak = localPeak }
                self.frames += Int64(out.frameLength)
                self.lock.unlock()
            }

            self.lock.lock()
            let f = self.file
            self.lock.unlock()
            try? f?.write(from: out)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("ENGINE_FAIL", "Falha ao iniciar a captura: \(error.localizedDescription)")
        }
    }

    /// Idempotente: chamada tanto pelo "stop" no stdin quanto por SIGTERM.
    func stop() {
        lock.lock()
        if stopped {
            lock.unlock()
            return
        }
        stopped = true
        lock.unlock()

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        lock.lock()
        // Fechar o AVAudioFile é o que descarrega o header do WAV.
        file = nil
        let seconds = Double(frames) / 16_000.0
        let capturedPeak = peak
        lock.unlock()

        emit([
            "event": "done",
            "seconds": seconds,
            "peak": Double(capturedPeak),
        ])
    }
}

func runRecord(path: String) -> Never {
    // O prompt de microfone só aparece se o Info.plist embutido tiver a
    // usage description, ver Helper-Info.plist.
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        semaphore.signal()
    }
    semaphore.wait()
    guard granted else {
        fail("MIC_DENIED", "Permissão de microfone negada.")
    }

    let recorder = Recorder()
    do {
        try recorder.start(path: path)
    } catch {
        fail("WRITE_FAIL", "Não foi possível gravar em \(path): \(error.localizedDescription)")
    }

    // Se o Electron morrer, não deixamos um WAV truncado nem o engine rodando.
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    termSource.setEventHandler {
        recorder.stop()
        exit(0)
    }
    signal(SIGTERM, SIG_IGN)
    termSource.resume()

    emit(["event": "ready"])

    // Bloqueia até o Electron mandar "stop" (ou fechar o stdin).
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }

    recorder.stop()
    exit(0)
}

// MARK: - Colar

/// Snapshot completo do clipboard para conseguirmos devolver o que estava lá.
func snapshotPasteboard(_ pb: NSPasteboard) -> [[String: Data]] {
    guard let items = pb.pasteboardItems else { return [] }
    return items.map { item in
        var copy: [String: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { copy[type.rawValue] = data }
        }
        return copy
    }
}

func restorePasteboard(_ pb: NSPasteboard, _ snapshot: [[String: Data]]) {
    pb.clearContents()
    guard !snapshot.isEmpty else { return }
    let items: [NSPasteboardItem] = snapshot.map { stored in
        let item = NSPasteboardItem()
        for (type, data) in stored {
            item.setData(data, forType: NSPasteboard.PasteboardType(type))
        }
        return item
    }
    pb.writeObjects(items)
}

func postCommandV() {
    let source = CGEventSource(stateID: .combinedSessionState)
    let vKey: CGKeyCode = 9  // kVK_ANSI_V

    guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
    else {
        fail("PASTE_FAIL", "Não foi possível criar o evento de teclado.")
    }
    // Flags explícitas: se o usuário ainda segura algum modificador, ignoramos.
    down.flags = .maskCommand
    up.flags = .maskCommand

    down.post(tap: .cghidEventTap)
    usleep(15_000)
    up.post(tap: .cghidEventTap)
}

/// Garante que o app alvo esteja em foco antes do ⌘V.
///
/// Sem isto, clicar num botão do overlay flutuante (ou trocar de app sem
/// querer) faria a colagem cair no lugar errado. O texto tem de voltar para
/// onde o cursor estava quando você começou a falar.
func ensureFront(_ bundleId: String) {
    guard !bundleId.isEmpty else { return }
    let workspace = NSWorkspace.shared
    if workspace.frontmostApplication?.bundleIdentifier == bundleId { return }

    let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    guard let target = candidates.first else { return }
    target.activate(options: [])

    // Espera o foco assentar, até 1 s, saindo assim que trocar.
    for _ in 0..<40 {
        usleep(25_000)
        if workspace.frontmostApplication?.bundleIdentifier == bundleId { return }
    }
}

func runPaste(restore: Bool, preDelayMs: UInt32, restoreDelayMs: UInt32, ensureFrontApp: String) -> Never {
    guard AXIsProcessTrusted() else {
        fail("AX_DENIED", "Permissão de Acessibilidade necessária para colar.")
    }
    ensureFront(ensureFrontApp)

    let raw = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(decoding: raw, as: UTF8.self)
    guard !text.isEmpty else {
        fail("EMPTY_TEXT", "Nada para colar.")
    }

    let pb = NSPasteboard.general
    let saved = restore ? snapshotPasteboard(pb) : []

    pb.clearContents()
    pb.setString(text, forType: .string)

    usleep(preDelayMs * 1000)
    postCommandV()

    if restore {
        usleep(restoreDelayMs * 1000)
        // Só devolve o clipboard antigo se o nosso texto ainda estiver lá,
        // caso o usuário tenha copiado outra coisa nesse meio tempo.
        if pb.string(forType: .string) == text {
            restorePasteboard(pb, saved)
        }
    }

    emit(["event": "pasted", "chars": text.count])
    exit(0)
}

// MARK: - Contexto e permissões

func runFrontApp() -> Never {
    // NSWorkspace não passa por TCC, diferente de perguntar via AppleScript.
    let app = NSWorkspace.shared.frontmostApplication
    emit([
        "event": "frontapp",
        "bundleId": app?.bundleIdentifier ?? "",
        "name": app?.localizedName ?? "",
    ])
    exit(0)
}

func micStatusString() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func runStatus() -> Never {
    let hasInput = AVCaptureDevice.default(for: .audio) != nil

    emit([
        "event": "status",
        "microphone": micStatusString(),
        "accessibility": AXIsProcessTrusted(),
        "inputDevice": hasInput,
    ])
    exit(0)
}

func runRequestAccessibility() -> Never {
    // Com prompt = true o macOS abre o diálogo e já cria a entrada na lista de
    // Acessibilidade, o que evita o usuário ter que arrastar um binário até lá.
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    let trusted = AXIsProcessTrustedWithOptions(options as CFDictionary)
    emit(["event": "accessibility", "trusted": trusted])
    exit(0)
}

func runRequestMic() -> Never {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        granted = ok
        semaphore.signal()
    }
    semaphore.wait()
    emit(["event": "microphone", "granted": granted, "status": micStatusString()])
    exit(0)
}

// MARK: - Entrada

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("USAGE", "Uso: vox-helper <record|paste|frontapp|status|request-accessibility|request-mic>")
}

func intFlag(_ name: String, _ fallback: UInt32) -> UInt32 {
    guard let i = args.firstIndex(of: name), i + 1 < args.count,
          let value = UInt32(args[i + 1]) else { return fallback }
    return value
}

func stringFlag(_ name: String, _ fallback: String) -> String {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return fallback }
    return args[i + 1]
}

switch command {
case "record":
    guard args.count >= 2 else { fail("USAGE", "Uso: vox-helper record <caminho.wav>") }
    runRecord(path: args[1])
case "paste":
    runPaste(
        restore: !args.contains("--no-restore"),
        preDelayMs: intFlag("--pre-delay", 90),
        restoreDelayMs: intFlag("--restore-delay", 450),
        ensureFrontApp: stringFlag("--ensure-front", "")
    )
case "frontapp":
    runFrontApp()
case "status":
    runStatus()
case "request-accessibility":
    runRequestAccessibility()
case "request-mic":
    runRequestMic()
default:
    fail("USAGE", "Comando desconhecido: \(command)")
}
