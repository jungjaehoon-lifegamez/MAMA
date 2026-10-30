#!/bin/sh
# MAMA OS installer (docs/development/work/install.md).
#
#   curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh
#   ... | sh -s -- --backend codex --no-init
#
# It installs a pinned Node.js into ~/.mama/node, MAMA OS into ~/.mama/npm, the `mama` command
# into ~/.mama/bin, the backend CLI with its vendor's installer when it is missing, and a marked
# PATH block in the login shell's startup file; then it runs `mama init`.
#
# The whole body is one function, called on the last line, so a download cut off midway runs
# nothing. scripts/sync-versions.js writes the version lines from package.json and
# install/node.json.

mama_install() {
  set -eu
  # mama init makes ~/.mama 0700 only when it creates it; this script may create it first.
  umask 077

  MAMA_OS_VERSION=0.78.0
  NODE_VERSION=22.23.4
  NODE_SHA256_DARWIN_ARM64=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
  NODE_SHA256_DARWIN_X64=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819
  NODE_SHA256_LINUX_X64=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
  NODE_SHA256_LINUX_ARM64=f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9

  say() { printf '%s\n' "$*"; }
  fail() {
    printf 'mama install: %s\n' "$*" >&2
    exit 1
  }
  # One shell word, single-quoted.
  quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

  usage() {
    say 'Usage: install.sh [--backend claude|codex] [--non-interactive | --no-init]'
    say '  --backend          the backend CLI MAMA runs; asked on the terminal when not given'
    say '  --non-interactive  run mama init --non-interactive (it reads MAMA_INIT_* variables)'
    say '  --no-init          install only, and print the mama init command'
    say 'Piped from curl: curl -fsSL <url> | sh -s -- --backend codex --no-init'
  }

  backend=''
  init_mode=terminal
  while [ $# -gt 0 ]; do
    case $1 in
      --backend)
        [ $# -ge 2 ] || fail '--backend needs claude or codex'
        backend=$2
        shift 2
        ;;
      --backend=*)
        backend=${1#--backend=}
        shift
        ;;
      --non-interactive | --no-init)
        [ "$init_mode" = terminal ] || fail 'choose one of --non-interactive and --no-init'
        init_mode=${1#--}
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        fail "unknown option: $1"
        ;;
    esac
  done
  case $backend in
    '' | claude | codex) ;;
    *) fail "--backend must be claude or codex, not $backend" ;;
  esac

  # The question and mama init read the terminal; piped from curl, stdin is the script itself.
  terminal=no
  if (: </dev/tty) 2>/dev/null; then terminal=yes; fi
  if [ "$terminal" = no ]; then
    [ -n "$backend" ] || fail 'no terminal to ask on: pass --backend claude or --backend codex'
    [ "$init_mode" != terminal ] ||
      fail 'mama init needs a terminal: pass --non-interactive (MAMA_INIT_* variables) or --no-init'
  fi

  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail 'HOME is not set to a folder'
  root=$HOME/.mama
  node_dir=$root/node
  prefix=$root/npm
  package=$prefix/lib/node_modules/@jungjaehoon/mama-os
  cli=$package/dist/cli/index.js
  wrapper=$root/bin/mama

  # Node moves are `mama update --node`'s (install.md, "Moving the managed Node"), which this
  # release does not have yet; a journal of one is not this installer's to finish or undo.
  if [ -e "$root/runtime/node-move.json" ]; then
    fail "$root/runtime/node-move.json records an unfinished move of the managed Node; this installer cannot finish or undo it. Nothing was changed."
  fi

  # Another install owns this account: a setup with no MAMA in the managed prefix.
  holds_mama=no
  [ -f "$package/package.json" ] && holds_mama=yes
  set_up=no
  [ -f "$root/config.yaml" ] && set_up=yes
  if [ "$holds_mama" = no ] && { [ "$set_up" = yes ] || [ -f "$root/start.sh" ]; }; then
    fail "$root is set up by another MAMA install (not in $prefix); this installer will not take it over. Nothing was changed. mama update --dry-run shows how that install updates."
  fi

  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "MAMA OS installs on macOS and Linux; this is $(uname -s)" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "MAMA OS installs on x64 and arm64; this is $(uname -m)" ;;
  esac
  case $os-$arch in
    darwin-arm64) node_sha256=$NODE_SHA256_DARWIN_ARM64 ;;
    darwin-x64) node_sha256=$NODE_SHA256_DARWIN_X64 ;;
    linux-x64) node_sha256=$NODE_SHA256_LINUX_X64 ;;
    linux-arm64) node_sha256=$NODE_SHA256_LINUX_ARM64 ;;
  esac

  # Every question before any change. ~/.local/bin is where the vendor installers put the backend.
  PATH=$HOME/.local/bin:$PATH
  export PATH
  if [ -z "$backend" ]; then
    for name in claude codex; do
      found=$(command -v "$name" 2>/dev/null || true)
      [ -n "$found" ] || found="not installed; this installer installs it with its vendor's installer"
      say "  $name: $found"
    done
    printf 'Backend MAMA runs (claude or codex): ' >/dev/tty
    IFS= read -r backend </dev/tty || fail 'no answer'
    case $backend in
      claude | codex) ;;
      *) fail "the backend is claude or codex, not $backend" ;;
    esac
  fi

  # Linux: the parent of member_root and tools_root, and linger, in one sudo call. sudo keeps the
  # umask 077 above; 022 inside, or the parent would be 0700 and init's folder check would fail.
  if [ "$os" = linux ]; then
    user=$(id -un)
    if ! printf '%s\n' "$user" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
      say "The user name $user has characters MAMA's default folders do not take, so nothing is run with sudo; mama init asks for two folders outside your home instead."
    elif [ -n "$(find /var/lib/mama -prune -type d -user 0 -perm 0755 2>/dev/null)" ] &&
      [ -n "$(find "/var/lib/mama/$user" -prune -type d -user "$(id -u)" -perm 0700 2>/dev/null)" ] &&
      [ -e "/var/lib/systemd/linger/$user" ]; then
      say "/var/lib/mama/$user is in place and linger is on."
    else
      privileged="umask 022; install -d -m 0755 /var/lib/mama; install -d -o $user -m 0700 /var/lib/mama/$user; loginctl enable-linger $user"
      say "MAMA keeps member workspaces and document tools under /var/lib/mama/$user, and linger keeps it running after you log out. This needs sudo once:"
      say "  sudo sh -c '$privileged'"
      if command -v sudo >/dev/null 2>&1 && sudo sh -c "$privileged" </dev/null; then
        say "Done."
      else
        say "That did not run. Run it yourself later; mama init offers other folders meanwhile."
      fi
    fi
  fi

  mkdir -p "$root"
  download=$root/node.$$.tar.gz
  unpack=$root/node.$$.tmp
  vendor_script=$root/backend-install.$$.sh
  trap 'rm -rf "$download" "$unpack" "$vendor_script"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Node.js: the pinned release, checked against the pinned SHA-256.
  node_now=''
  if [ -x "$node_dir/bin/node" ]; then
    node_now=$("$node_dir/bin/node" --version </dev/null 2>/dev/null || true)
  fi
  if [ "$node_now" = "v$NODE_VERSION" ]; then
    say "Node.js $NODE_VERSION is in place: $node_dir"
  elif [ "$set_up" = yes ] && [ -n "$node_now" ]; then
    # Moving the Node a set-up install runs is `mama update --node`'s, not this script's.
    say "MAMA runs Node.js ${node_now#v} from $node_dir; this installer pins $NODE_VERSION. It is left as it is."
  else
    command -v curl >/dev/null 2>&1 || fail 'curl is needed to download Node.js'
    if command -v shasum >/dev/null 2>&1; then
      sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
    else
      fail 'shasum or sha256sum is needed to check the Node.js download'
    fi
    node_file=node-v$NODE_VERSION-$os-$arch.tar.gz
    node_url=https://nodejs.org/dist/v$NODE_VERSION/$node_file
    say "Downloading Node.js $NODE_VERSION: $node_url"
    curl -fsSL -o "$download" "$node_url" </dev/null || fail "could not download $node_url"
    actual=$(sha256 "$download")
    if [ "$actual" != "$node_sha256" ]; then
      rm -f "$download"
      fail "$node_file has SHA-256 $actual, not $node_sha256, which this installer pins; the download was deleted and nothing was unpacked."
    fi
    rm -rf "$unpack"
    mkdir "$unpack"
    tar -xzf "$download" -C "$unpack" --strip-components 1 </dev/null
    rm -f "$download"
    [ "$("$unpack/bin/node" --version </dev/null)" = "v$NODE_VERSION" ] ||
      fail "the unpacked $node_file does not run as Node.js $NODE_VERSION"
    rm -rf "$node_dir"
    mv "$unpack" "$node_dir"
    say "Node.js $NODE_VERSION installed: $node_dir"
  fi

  # MAMA OS, with the managed Node's own npm and that Node first on PATH, as mama update runs it.
  installed=''
  if [ -d "$prefix" ]; then
    installed=$(PATH="$node_dir/bin:$PATH" "$node_dir/bin/npm" ls -g --prefix "$prefix" \
      --depth=0 --parseable --long @jungjaehoon/mama-os </dev/null 2>/dev/null |
      sed -n 's|.*:@jungjaehoon/mama-os@\([^:]*\).*|\1|p' || true)
  fi
  if [ "$set_up" = yes ]; then
    say "MAMA OS ${installed:-(unreadable)} is installed in $prefix; mama update updates it."
  elif [ "$installed" = "$MAMA_OS_VERSION" ]; then
    say "MAMA OS $MAMA_OS_VERSION is in place: $prefix"
  else
    say "Installing @jungjaehoon/mama-os@$MAMA_OS_VERSION into $prefix"
    PATH="$node_dir/bin:$PATH" "$node_dir/bin/npm" install -g --prefix "$prefix" \
      --no-audit --no-fund "@jungjaehoon/mama-os@$MAMA_OS_VERSION" </dev/null ||
      fail "npm could not install @jungjaehoon/mama-os@$MAMA_OS_VERSION (its error is above). $prefix is left for the next run of this installer, which installs it again."
  fi
  [ -f "$cli" ] || fail "$cli is missing; run this installer again to reinstall MAMA OS"

  # `mama`: the managed Node on the package's CLI by full paths. The bin's own `#!/usr/bin/env node`
  # would run whichever Node comes first, or none on a clean account.
  write_file() {
    if [ -f "$1" ] && printf '%s\n' "$2" | cmp -s - "$1"; then return 1; fi
    mkdir -p "$(dirname "$1")"
    # Through the existing file, so a startup file that is a link stays one.
    printf '%s\n' "$2" >"$1"
  }
  if write_file "$wrapper" "#!/bin/sh
exec $(quote "$node_dir/bin/node") $(quote "$cli") \"\$@\""; then
    chmod 700 "$wrapper"
    say "mama command written: $wrapper"
  fi
  other=$(command -v mama 2>/dev/null || true)
  if [ -n "$other" ] && [ "$other" != "$wrapper" ]; then
    say "Another mama comes first on this PATH: $other. The startup block below puts $wrapper ahead of it in new terminals."
  fi

  # The backend CLI: kept when it is on PATH (mama init checks its version and sign-in), else the
  # vendor's documented installer, into ~/.local/bin.
  backend_path=$(command -v "$backend" 2>/dev/null || true)
  if [ -n "$backend_path" ]; then
    say "$backend is installed: $backend_path"
  else
    case $backend in
      claude)
        vendor_url=https://claude.ai/install.sh
        vendor_page=https://code.claude.com/docs/en/setup
        vendor_shell='bash'
        ;;
      codex)
        vendor_url=https://chatgpt.com/codex/install.sh
        vendor_page=https://learn.chatgpt.com/docs/codex/cli
        vendor_shell='sh'
        ;;
    esac
    say "Installing $backend with its vendor's installer: curl -fsSL $vendor_url | $vendor_shell"
    command -v curl >/dev/null 2>&1 || fail "curl is needed to install $backend; see $vendor_page"
    # Fetched first, so a failed download is not an installer that ran on nothing.
    curl -fsSL -o "$vendor_script" "$vendor_url" </dev/null ||
      fail "could not download $vendor_url; see $vendor_page"
    if [ "$backend" = codex ]; then
      # On a terminal Codex's installer offers to start Codex on ~/.codex, not the home MAMA gives
      # it; its install folder stays ~/.local/bin, which the startup block names.
      (
        unset CODEX_HOME CODEX_INSTALL_DIR
        CODEX_NON_INTERACTIVE=1 sh "$vendor_script"
      ) </dev/null || fail "the codex installer failed (its output is above); see $vendor_page"
    else
      bash "$vendor_script" </dev/null ||
        fail "the claude installer failed (its output is above); see $vendor_page"
    fi
    rm -f "$vendor_script"
    backend_path=$(command -v "$backend" 2>/dev/null || true)
    [ -n "$backend_path" ] ||
      fail "$backend's installer finished, but $backend is not on PATH or in $HOME/.local/bin; see $vendor_page"
    say "$backend installed: $backend_path"
  fi

  # The login shell's startup file: the text between the markers is rewritten on each run.
  path_line="export PATH=\"\$HOME/.mama/bin:\$PATH\""
  fish_dirs="$root/bin"
  if [ -x "$HOME/.local/bin/$backend" ]; then
    path_line="export PATH=\"\$HOME/.mama/bin:\$HOME/.local/bin:\$PATH\""
    fish_dirs="$fish_dirs $HOME/.local/bin"
  fi
  startup=''
  case $(basename "${SHELL:-sh}") in
    zsh) startup=$HOME/.zshrc ;;
    bash)
      if [ "$os" = linux ]; then
        startup=$HOME/.bashrc
      elif [ ! -f "$HOME/.bash_profile" ] && [ -f "$HOME/.profile" ]; then
        startup=$HOME/.profile
      else
        startup=$HOME/.bash_profile
      fi
      ;;
    fish)
      say "fish: run once to put mama on PATH: fish_add_path $fish_dirs"
      ;;
    *) startup=$HOME/.profile ;;
  esac
  if [ -n "$startup" ]; then
    block="# >>> mama >>>
# Written by the MAMA OS installer; each run rewrites the lines between these markers.
$path_line
# <<< mama <<<"
    current=''
    if [ -f "$startup" ]; then
      opened=$(grep -c '^# >>> mama >>>$' "$startup" || true)
      closed=$(grep -c '^# <<< mama <<<$' "$startup" || true)
      [ "$opened" = "$closed" ] ||
        fail "$startup has a '# >>> mama >>>' line without its '# <<< mama <<<' line, or the other way round; fix it, then run this installer again"
      current=$(cat "$startup")
    fi
    updated=$(printf '%s\n' "$current" | MAMA_BLOCK=$block awk '
      $0 == "# >>> mama >>>" { if (!done) print ENVIRON["MAMA_BLOCK"]; done = 1; skip = 1; next }
      skip { if ($0 == "# <<< mama <<<") skip = 0; next }
      { print }
      END {
        if (!done) {
          if (NR > 0 && last != "") print ""
          print ENVIRON["MAMA_BLOCK"]
        }
      }
      { last = $0 }
    ')
    # An absent or empty file gets the block alone.
    [ -n "$current" ] || updated=$block
    if write_file "$startup" "$updated"; then
      say "PATH block written in $startup"
    fi
  fi

  # mama init: npm and init run by full path with the managed Node first on PATH.
  case $init_mode in
    no-init)
      say "Installed. Open a new terminal and run: mama init"
      say "(or now: $wrapper init)"
      ;;
    non-interactive)
      PATH="$node_dir/bin:$PATH" "$wrapper" init --non-interactive </dev/null
      ;;
    terminal)
      # mama init requires a terminal on both stdin and stdout.
      PATH="$node_dir/bin:$PATH" "$wrapper" init </dev/tty >/dev/tty
      say "Open a new terminal to have mama on PATH."
      ;;
  esac
}

mama_install "$@"
