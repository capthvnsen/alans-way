'use strict';

// sshd starts a non-login shell, so install.sh/pipx's ~/.local/bin and
// Homebrew/user-pip tools may be absent. Keep the supplied PATH first, then
// add known install directories without sourcing profiles (which can print,
// prompt or hang). No subprocesses, eval, or interpolation of command text.
const USER_TOOL_PATH = `export PATH="\${PATH:+$PATH:}$HOME/.local/bin:\${HERMES_HOME:-$HOME/.hermes}/bin:/usr/local/bin:/opt/homebrew/bin"
for _alan_bin in "$HOME"/Library/Python/*/bin; do
  [ ! -d "$_alan_bin" ] || PATH="$PATH:$_alan_bin"
done
unset _alan_bin
`;

// A prelude, rather than sh -c or bash -lc, preserves stdin, quoting, exit
// status and the caller's existing deadline. Only use for known POSIX guests.
const posixCommand = (command) => USER_TOOL_PATH + command;
module.exports = { posixCommand };
