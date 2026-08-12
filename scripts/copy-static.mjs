import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// O renderer é HTML/JS puro: não passa pelo tsc, só é copiado para dist/.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, 'src', 'renderer');
const to = path.join(root, 'dist', 'renderer');

fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(from)) {
  fs.copyFileSync(path.join(from, name), path.join(to, name));
}
console.log(`renderer copiado para dist/renderer (${fs.readdirSync(to).length} arquivos)`);
