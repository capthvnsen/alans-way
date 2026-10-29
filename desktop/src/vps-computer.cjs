'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createComputer } = require('./computer-helper.cjs');

const script = path.join(__dirname, '..', 'scripts', 'vps-computer.py');
// Hermes puts its bundled Python, which has no python3-gi, first on an MCP server's PATH (#220).
const python = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';

const { service, close } = createComputer({ command: async (mode) => [python, script, mode] });

module.exports = { service, close, python };
