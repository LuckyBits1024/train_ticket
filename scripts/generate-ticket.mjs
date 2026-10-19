#!/usr/bin/env node
// npm entry point; the renderer itself is a portable Python/Pillow script.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localPython = path.join(root, '.venv-ticket', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.TICKET_PYTHON || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const args = process.argv.slice(2);
const isTest = args[0] === '--test';
const script = path.join(root, 'scripts', isTest ? 'test-ticket.py' : 'generate-ticket.py');
const result = spawnSync(python, [script, ...args.slice(isTest ? 1 : 0)], { stdio: 'inherit' });
if (result.error) {
  console.error(`无法启动 Python：${result.error.message}\n请安装 Python 3.9+，或通过 TICKET_PYTHON 指定解释器。`);
}
process.exit(result.status ?? 1);
