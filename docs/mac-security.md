# Mac server security boundary (alpha)

This is a narrowly scoped, read-only Mac MCP server, not a general Mac agent or
an OS sandbox. It does not implement cloud/Desktop session continuity, session
synchronization, remote authentication, tunnels, service installation, or a
background launch agent. Run it only as a local stdio subprocess of a trusted
MCP client. No HTTP listener is provided.

## Startup and authority

The operator supplies `--workspace` explicitly. It must identify an existing,
absolute directory whose final component is not a symlink. Ancestor aliases are
resolved at startup. Use a dedicated directory containing only material you
intend to share; do not approve your home directory, a profile directory, or a
credentials tree. Supplying a workspace grants read authority to the client;
there is no per-call consent dialogue or approval-token mechanism.

Both `MacExecutor` construction and MCP startup require Darwin. Other hosts
fail before workspace inspection or optional SDK imports, rather than reporting
a cloud/Linux device as a Mac. Unsupported-host, invalid-workspace and missing
or unverified-SDK startup errors exit with status 2, no MCP stdout, and a
sanitized diagnostic without the supplied workspace path or traceback.

`MacExecutor` uses the Python standard library and can be imported and used
without the optional SDK. `build_server()` imports the SDK lazily and requires
exactly `mcp==2.0.0`, provided by the `mcp` extra. A different SDK version is
refused, not silently accepted. The module entry point is:

```sh
python -m hermes_companion.mac_server --workspace /absolute/path/to/dedicated-workspace
```

The package CLI delegates `hermes-companion serve-mac --workspace ...` to
`main(argv=None)`. This document describes the server boundary, not a deployed
remote integration.

## Exactly three tools

| Tool | Data exposed |
| --- | --- |
| `mac_device_status` | Execution-host tag, OS system, release, machine architecture. No hostname, username, IP, process inventory, or profile data. |
| `mac_workspace_read_file` | Requested relative path and bounded UTF-8 text from one eligible workspace file. |
| `mac_workspace_list` | Requested relative directory and sorted eligible entry names/types, with a truncation flag. No file contents. |

All three declare `read_only_hint=true`, `destructive_hint=false`,
`idempotent_hint=true`, and `open_world_hint=false`. These annotations describe
intent, not an enforcement mechanism; enforcement is in the executor. Reads
and listings can change as other processes edit files, despite the idempotency
annotation.

There are no write, shell, subprocess execution, browser, password, OTP,
payment, mail, sampling, or elicitation/approval handlers. Unknown tools fail.
Arguments such as `approved` or `approval_receipt` cannot enlarge the workspace
or bypass a path denial. A client with a separate shell or browser tool still
has that separate authority; this server does not sandbox its client.

## Filesystem policy

- Paths are slash-separated and workspace-relative. Absolute paths, traversal,
  empty or dot-prefixed components, backslashes, colons, ASCII control
  characters, non-UTF-8-encodable names, paths over 1,024 characters, and
  components over 255 UTF-8 bytes are denied. `.` is allowed only for listing
  the workspace root.
- Each component is checked case-insensitively for the substrings `auth`,
  `secret`, `password`, `passwd`, `credential`, `token`, `private`, `otp`,
  `cookie`, `keychain`, `api_key`, `api-key`, and `apikey`. The suffixes `.pem`,
  `.key`, `.p12`, `.pfx`, and `.kdbx` are also denied. This deliberately causes
  false positives; it is not a secret scanner.
- The approved root's device/inode pair is recorded at startup and checked
  every time a root descriptor is opened. Replacing the root does not
  authorize the replacement. Restart with the intended root to change scope.
- Traversal opens child components relative to directory descriptors with
  `O_NOFOLLOW`. Intermediate components must be directories. Symlinks are
  never followed inside the workspace, including aliases to permitted files.
- Reads require a regular file with exactly one hard link and at most 65,536
  bytes. A bounded read also detects growth beyond that cap. Metadata is
  checked again after reading; observed content/size/link-count/metadata
  changes cause a denial rather than returning the read content.
- Text must decode strictly as UTF-8. NUL, DEL and ASCII control bytes other
  than tab, carriage return and newline are rejected. Newlines are preserved.
  This excludes common binary content, but valid UTF-8 under a benign name is
  not proof that a file is harmless or free of secrets.
- Listing examines at most 256 entries and returns at most 100 eligible
  entries. It may fetch one additional, unexamined entry to determine
  truncation. File eligibility uses the same read policy, discarding content.
  Selection follows filesystem enumeration order; only the returned subset
  is sorted. There is no pagination or exhaustive inventory guarantee.
- Filesystem failures and policy denials use sanitized exception messages.
  MCP tool errors do not return absolute workspace paths or denied content.

## Trust assumptions and limitations

Read-only means the server does not write file contents or run commands.
Normal OS read effects, such as access-time metadata or client-side logging,
are not prohibited. A permitted file can contain sensitive material, prompt
injection, or a copied secret; curate the workspace yourself. Returned text is
untrusted data, not instructions.

The operator, Python interpreter, installed SDK, and local filesystem are
trusted. This is not isolation against a malicious local process, privileged
attacker, mount manipulation, or a compromised dependency. Descriptor traversal
and metadata rechecks mitigate common replacement races; they do not provide
an atomic filesystem snapshot or guarantee detection of every concurrent
mutation. A listing can omit entries that change or become ineligible. Workspace
root checks use device/inode identity, not a cryptographic capability. There is
no network authentication or protection for a client that forwards stdio to an
untrusted peer. The server has not been independently audited.

## Verification

From a source checkout with `src` on `PYTHONPATH`:

```sh
PYTHONPATH=src python -m unittest discover -s tests -p 'test_mac_*.py' -v
PYTHONPATH=src python -S -m unittest discover -s tests -p 'test_mac_*.py' -v
```

Tests use synthetic `tempfile` workspaces honoring `TMPDIR`; they never require
personal files or configured accounts. Unit policy tests explicitly emulate
Darwin for synthetic POSIX filesystem operations so those algorithms can run
on Linux. That is not evidence of real Mac protocol success.

Successful MCP subprocess tests require a real Darwin host and exactly the
verified SDK. They exercise initialization, the exact annotated tool inventory,
actual reads/listings, denials, root replacement, and unsupported sensitive
operations. They advertise sampling/elicitation callbacks and verify that no
such callbacks are invoked. On Linux those success tests are skipped and a
real subprocess startup-denial test runs instead. SDK-free runs skip SDK-based
success tests while still exercising the standard-library policy. Test skips
must be reported; simulated platform guards do not establish a real Linux
subprocess result on a Mac.

## Desktop control permissions

Controlling other apps is a separate path from this server: the Alan's
Workspace app on the Mac runs the helper, so macOS Accessibility and Screen
Recording belong to `alans-way-localapp` itself. Grant both at the Mac, in System Settings >
Privacy & Security. The agent's SSH session needs no grant of its own, because
it only relays requests to the app over its loopback API. Grant nothing to
Terminal, `sshd` or Node.
