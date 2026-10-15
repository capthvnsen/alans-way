'use strict';

// sshd starts a non-login shell, so install.sh/pipx's ~/.local/bin and
// Homebrew/user-pip tools may be absent. Keep the supplied PATH first, then
// add known install directories without sourcing profiles (which can print,
// prompt or hang). No subprocesses, eval, or interpolation of command text.
// Enumerate Python versions explicitly: an unmatched glob aborts zsh and
// errors under bash failglob before the requested command can run.
const USER_TOOL_PATH = `for _alan_bin in "$HOME/.local/bin" "\${HERMES_HOME:-$HOME/.hermes}/bin" /usr/local/bin /opt/homebrew/bin; do
  [ ! -d "$_alan_bin" ] || PATH="\${PATH:+$PATH:}$_alan_bin"
done
for _alan_python in 2.7 3.0 3.1 3.2 3.3 3.4 3.5 3.6 3.7 3.8 3.9 3.10 3.11 3.12 3.13 3.14 3.15; do
  _alan_bin="$HOME/Library/Python/$_alan_python/bin"
  [ ! -d "$_alan_bin" ] || PATH="\${PATH:+$PATH:}$_alan_bin"
done
export PATH
unset _alan_bin _alan_python
`;

// A prelude, rather than sh -c or bash -lc, preserves stdin, quoting, exit
// status and the caller's existing deadline. Only use for known POSIX guests.
const posixCommand = (command) => USER_TOOL_PATH + command;
module.exports = { posixCommand };
