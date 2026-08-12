/* Overlay flutuante: cronômetro próprio, duas ações. */

const label = document.getElementById('label');
let timer = null;

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function format(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

window.overlay.onState((payload) => {
  if (payload.state === 'recording') {
    document.body.classList.remove('busy');
    // O cronômetro roda aqui em vez de vir por IPC: menos mensagens e o
    // relógio não trava se o processo principal estiver ocupado.
    const startedAt = payload.startedAt ?? Date.now();
    const tick = () => {
      label.textContent = format(Date.now() - startedAt);
    };
    tick();
    stopTimer();
    timer = setInterval(tick, 250);
    return;
  }

  document.body.classList.add('busy');
  stopTimer();
  label.textContent = payload.label ?? 'Processando…';
});

document.getElementById('stop').addEventListener('click', () => window.overlay.stop());
document.getElementById('cancel').addEventListener('click', () => window.overlay.cancel());
