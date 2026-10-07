'use strict';

const path = require('node:path');
const { createComputer } = require('./computer-helper.cjs');

const script = path.join(__dirname, '..', 'scripts', 'vps-computer.py');

const { service, close } = createComputer({ command: async (mode) => ['python3', script, mode] });

module.exports = { service, close };
