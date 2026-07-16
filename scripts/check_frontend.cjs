'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [];
function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(target);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
}
collect(path.join(root, 'frontend'));
files.push(path.join(root, 'service-worker.js'));

const problems = [];
for (const file of files) {
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (syntax.status !== 0) problems.push(`${path.relative(root, file)}: JavaScript syntax error\n${syntax.stderr}`);
    const source = fs.readFileSync(file, 'utf8');
    if (/\bdebugger\s*;/.test(source)) problems.push(`${path.relative(root, file)}: debugger statement is not allowed`);
    if (/console\.(?:log|debug|error)\s*\(/.test(source)) problems.push(`${path.relative(root, file)}: production console logging is not allowed`);
    if (/sourceMappingURL\s*=/.test(source)) problems.push(`${path.relative(root, file)}: source-map references are not allowed`);
}

const authSource = fs.readFileSync(path.join(root, 'frontend', 'app-shell', 'auth.js'), 'utf8');
if (/(localStorage|sessionStorage)\.(setItem|getItem)\([^\n]*(access_token|refresh_token)/.test(authSource)) {
    problems.push('frontend/app-shell/auth.js: auth tokens must not use web storage');
}

if (problems.length) {
    console.error(problems.join('\n\n'));
    process.exit(1);
}
console.log(`Frontend lint passed for ${files.length} JavaScript files.`);
