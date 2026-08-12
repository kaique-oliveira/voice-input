import type { Config, Mode } from './config';

/**
 * Mapeamento de app em foco para modo de correção.
 *
 * A detecção usa NSWorkspace (ver VoxHelper.swift), que não passa por TCC,
 * é instantânea e não pede nenhuma permissão.
 */
export const DEFAULT_APP_MODES: Record<string, Mode> = {
  // Editores e IDEs
  'com.todesktop.230313mzl4w4u92': 'developer', // Cursor
  'com.microsoft.VSCode': 'developer',
  'com.microsoft.VSCodeInsiders': 'developer',
  'com.visualstudio.code.oss': 'developer',
  'dev.zed.Zed': 'developer',
  'com.apple.dt.Xcode': 'developer',
  'com.sublimetext.4': 'developer',

  // Terminais
  'com.apple.Terminal': 'developer',
  'com.googlecode.iterm2': 'developer',
  'dev.warp.Warp-Stable': 'developer',
  'com.mitchellh.ghostty': 'developer',
  'net.kovidgoyal.kitty': 'developer',
  'co.zeit.hyper': 'developer',

  // Assistentes de código
  'com.anthropic.claudefordesktop': 'developer',
  'com.openai.chat': 'developer',

  // Ferramentas de dev
  'com.github.GitHubClient': 'developer',
  'com.postmanlabs.mac': 'developer',
  'com.tinyapp.TablePlus': 'developer',
  'com.docker.docker': 'developer',

  // Conversas do dia a dia
  'net.whatsapp.WhatsApp': 'normal',
  'desktop.WhatsApp': 'normal',
  'com.apple.MobileSMS': 'normal',
  'com.apple.mail': 'normal',
  'com.tinyspeck.slackmacgap': 'normal',
  'com.hnc.Discord': 'normal',
  'ru.keepcoder.Telegram': 'normal',
  'com.apple.Notes': 'normal',
  'notion.id': 'normal',
  'com.linear': 'normal',
};

/**
 * Rede de segurança para apps cujo bundle id eu não conheço (Antigravity, IDEs
 * da JetBrains, forks do VS Code). Casa contra o nome visível do app.
 */
export const DEFAULT_NAME_RULES: Array<{ pattern: string; mode: Mode }> = [
  { pattern: 'antigravity', mode: 'developer' },
  { pattern: 'cursor', mode: 'developer' },
  { pattern: 'claude', mode: 'developer' },
  { pattern: 'terminal|iterm|warp|ghostty|kitty|alacritty|tmux', mode: 'developer' },
  { pattern: 'code|studio|intellij|webstorm|pycharm|goland|rider|datagrip', mode: 'developer' },
  { pattern: 'docker|postman|insomnia|tableplus|dbeaver|sequel', mode: 'developer' },
  { pattern: 'whatsapp|telegram|messenger|signal', mode: 'normal' },
];

export interface FrontApp {
  bundleId: string;
  name: string;
}

/**
 * Resolve o modo efetivo. Ordem: override manual → bundle id → nome do app →
 * fallback configurado.
 */
export function resolveMode(config: Config, front: FrontApp | null): Mode {
  if (config.mode !== 'auto') return config.mode;
  if (!front) return config.fallbackMode;

  const byId = config.appModes[front.bundleId];
  if (byId) return byId;

  const haystack = `${front.name} ${front.bundleId}`.toLowerCase();
  for (const rule of config.nameRules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(haystack)) return rule.mode;
    } catch {
      // Regex inválida vinda das configurações: ignora em vez de quebrar.
    }
  }
  return config.fallbackMode;
}
