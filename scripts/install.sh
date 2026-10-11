#!/bin/sh
# Install the room command into ~/.project-room/bin.
# No sudo. Does not edit shell profiles.
set -eu

home="${PROJECT_ROOM_HOME:-$HOME}"
if [ -z "${home}" ]; then
  echo "Set HOME, or PROJECT_ROOM_HOME, to the directory that should contain .project-room." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24.19 or newer, then run this installer again." >&2
  exit 1
fi

node --input-type=module -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 19)) { console.error("Install Node.js 24.19 or newer. This machine has " + process.version + "."); process.exit(1); }'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${PROJECT_ROOM_TARBALL:-}" ]; then
  if [ -z "${PROJECT_ROOM_CHECKSUMS:-}" ]; then
    echo "Set PROJECT_ROOM_CHECKSUMS to the release checksums file." >&2
    exit 1
  fi
  tarball="$PROJECT_ROOM_TARBALL"
  sums="$PROJECT_ROOM_CHECKSUMS"
else
  api="https://api.github.com/repos/Uuriko/project-room/releases/latest"
  if [ -n "${PROJECT_ROOM_RELEASE_API:-}" ]; then
    api="$PROJECT_ROOM_RELEASE_API"
  fi
  PROJECT_ROOM_RELEASE_API_URL="$api" PROJECT_ROOM_DOWNLOAD_DIR="$tmp" node --input-type=module -e '
    const response = await fetch(process.env.PROJECT_ROOM_RELEASE_API_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "project-room-install" } });
    if (!response.ok) { console.error("The release list did not answer. Refusing to install."); process.exit(1); }
    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const sumsAsset = assets.find(asset => asset && /^(SHA256SUMS|checksums\.txt)$/.test(asset.name) && asset.browser_download_url);
    const tarAsset = assets.find(asset => asset && typeof asset.name === "string" && asset.name.endsWith(".tar.gz") && asset.browser_download_url);
    const tarballUrl = tarAsset ? tarAsset.browser_download_url : release.tarball_url;
    if (!sumsAsset || !tarballUrl) { console.error("This release has no checksums file. Refusing to install."); process.exit(1); }
    const { writeFileSync } = await import("node:fs");
    const pull = async (url, path) => {
      const body = await fetch(url, { headers: { "user-agent": "project-room-install" } });
      if (!body.ok) { console.error("The release download did not answer. Refusing to install."); process.exit(1); }
      writeFileSync(path, new Uint8Array(await body.arrayBuffer()));
    };
    const dir = process.env.PROJECT_ROOM_DOWNLOAD_DIR;
    // Keep the asset name: SHA256SUMS lists the tarball by that name, and
    // the checksum step matches on it.
    const name = tarAsset && /^[A-Za-z0-9._-]+\.tar\.gz$/.test(tarAsset.name) ? tarAsset.name : "release.tar.gz";
    await pull(sumsAsset.browser_download_url, dir + "/SHA256SUMS");
    await pull(tarballUrl, dir + "/" + name);
    writeFileSync(dir + "/tarball-name", name);
  '
  tarball="$tmp/$(cat "$tmp/tarball-name")"
  sums="$tmp/SHA256SUMS"
fi

PROJECT_ROOM_VERIFY_FILE="$tarball" PROJECT_ROOM_VERIFY_SUMS="$sums" node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  import { basename } from "node:path";
  const file = process.env.PROJECT_ROOM_VERIFY_FILE;
  const sums = readFileSync(process.env.PROJECT_ROOM_VERIFY_SUMS, "utf8");
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  const base = basename(file);
  const ok = sums.split("\n").some(line => {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    return Boolean(match && match[1].toLowerCase() === hash && (match[2] === base || match[2].endsWith("/" + base)));
  });
  if (!ok) { console.error("Checksum does not match. Refusing to install."); process.exit(1); }
'

extract="$tmp/extract"
mkdir -p "$extract"
tar -xzf "$tarball" -C "$extract"
found=$(find "$extract" -type f -path '*/bin/room.mjs' | head -n 1)
if [ -z "$found" ]; then
  echo "The release tarball has no bin/room.mjs. Refusing to install." >&2
  exit 1
fi
root=$(dirname "$(dirname "$found")")
runtime="$home/.project-room/runtime"
bindir="$home/.project-room/bin"
rm -rf "$runtime"
mkdir -p "$bindir"
cp -a "$root/." "$runtime/"
cat > "$bindir/room" <<EOF
#!/bin/sh
exec node "$runtime/bin/room.mjs" "\$@"
EOF
chmod 755 "$bindir/room"
echo "Installed room to $bindir/room"
echo "Add $bindir to PATH if your shell does not already search it."
echo "room setup <tool>"
