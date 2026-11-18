#!/usr/bin/env bash
# System-wide translation of codev-office-ubuntu-setup.sh for the sandbox
# guest image. Runs inside the Docker build as root; $1 is the staged bundle
# dir (the whole codev-office-ubuntu bundle, minus its macOS-only artifacts).
#
# The bundle is the proven set: the office skills are tested against exactly
# these component versions, so these are the versions installed here. Every
# version is read off the bundle's own filenames rather than pinned again in
# this file, so refreshing the bundle moves the image with it.
#
# The bundle's binaries are x86_64-only. On arm64 the same version is fetched
# arch-correct instead (the build machine has internet; the sealed guest will
# not) — the arch changes, the version never does. Anything the bundle pins
# that cannot be matched on this arch is a hard failure, not a substitution.
#
# The per-user layout of the setup script becomes system-wide here, because
# sandbox homes are fresh: /etc/skel seeds each one (vz at image build, other
# backends from their boot scripts).
set -euxo pipefail
BUNDLE="${1:-/tmp/office-bundle}"
ARCH="$(dpkg --print-architecture)"
OFFICE_HOME=/opt/codev-office

bundled() { ls "$BUNDLE"/$1 2>/dev/null | head -1 || true; }
require() { [ -n "$2" ] || { echo "office bundle is missing $1" >&2; exit 1; }; }

# dpkg -i does not resolve dependencies and the guest is a slim Debian: the
# TDF LibreOffice debs and the .NET SDK both need libraries that are not here
# by default. `apt-get install -f` after each dpkg pulls what they name; ICU
# is installed up front because dotnet refuses to run without it (the setup
# script's alternative, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT, silently
# changes culture behaviour, so give it the real thing instead).
apt-get update
apt-get install -y --no-install-recommends libicu72 fonts-dejavu fonts-liberation2

# --- .NET SDK (required by the docx/xlsx skills) ---
# An 8.x SDK specifically, and this exact 8.x: only SDK 8 carries the net8.0
# targeting packs locally, and a newer SDK tries to restore them from NuGet,
# which the offline feed does not carry (NU1101).
dotnet_tar="$(bundled 'dotnet-sdk-*-linux-x64.tar.gz')"
require "dotnet-sdk-*-linux-x64.tar.gz" "$dotnet_tar"
DOTNET_VERSION="$(basename "$dotnet_tar" | sed -E 's/^dotnet-sdk-(.+)-linux-x64\.tar\.gz$/\1/')"
mkdir -p /opt/dotnet
if [ "$ARCH" = "amd64" ]; then
  tar -xzf "$dotnet_tar" -C /opt/dotnet
else
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  bash /tmp/dotnet-install.sh --version "$DOTNET_VERSION" --install-dir /opt/dotnet --architecture arm64
  rm /tmp/dotnet-install.sh
fi
ln -sf /opt/dotnet/dotnet /usr/local/bin/dotnet
dotnet --list-sdks | grep -q "^${DOTNET_VERSION} " || {
  echo "expected .NET SDK ${DOTNET_VERSION}, got: $(dotnet --list-sdks)" >&2
  exit 1
}

# --- pandoc ---
pandoc_deb="$(bundled 'pandoc-*-amd64.deb')"
require "pandoc-*-amd64.deb" "$pandoc_deb"
PANDOC_VERSION="$(basename "$pandoc_deb" | sed -E 's/^pandoc-([0-9.]+)-[0-9]+-amd64\.deb$/\1/')"
if [ "$ARCH" = "amd64" ]; then
  pandoc_install="$pandoc_deb"
else
  pandoc_install=/tmp/pandoc-arm64.deb
  curl -fsSL -o "$pandoc_install" \
    "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/$(basename "${pandoc_deb%-amd64.deb}-arm64.deb")"
fi
dpkg -i "$pandoc_install" || apt-get install -y --no-install-recommends -f
rm -f /tmp/pandoc-arm64.deb
pandoc --version | head -1 | grep -q "${PANDOC_VERSION}"

# --- LibreOffice ---
lo_tar="$(bundled 'LibreOffice_*_Linux_x86-64_deb.tar.gz')"
require "LibreOffice_*_Linux_x86-64_deb.tar.gz" "$lo_tar"
LO_VERSION="$(basename "$lo_tar" | sed -E 's/^LibreOffice_(.+)_Linux_x86-64_deb\.tar\.gz$/\1/')"
if [ "$ARCH" = "amd64" ]; then
  lo_install="$lo_tar"
else
  lo_install=/tmp/libreoffice-aarch64.tar.gz
  curl -fsSL -o "$lo_install" \
    "https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/deb/aarch64/LibreOffice_${LO_VERSION}_Linux_aarch64_deb.tar.gz"
fi
lo_tmp="$(mktemp -d)"
tar -xzf "$lo_install" -C "$lo_tmp"
dpkg -i "$lo_tmp"/LibreOffice_*/DEBS/*.deb || apt-get install -y --no-install-recommends -f
rm -rf "$lo_tmp" /tmp/libreoffice-aarch64.tar.gz
# The TDF debs declare almost no dependencies, so `dpkg -i` succeeds and the
# `-f` fallback above never fires — while LibreOffice still needs a pile of
# system libraries a slim Debian does not carry. Hand-listing them does not
# work: it dlopens several (libnss3's libssl3.so, libcairo.so.2), so they are
# invisible to ldd and surface only as "error while loading shared libraries"
# the first time soffice runs. Debian packages the same software, so its
# libreoffice-core dependencies are the authoritative list — take those and
# let apt resolve them, rather than maintaining a guess here.
apt-get install -y --no-install-recommends $(
  apt-cache depends --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances \
    libreoffice-core | awk '/Depends:/ {print $2}' | grep -vE '^(libreoffice|ure|<)' | sort -u
)
# The debs only create a versioned /usr/local/bin/libreofficeX.Y symlink, but
# doc_to_docx.sh (docx skill) resolves LibreOffice solely as `soffice` on PATH.
if ! command -v soffice >/dev/null 2>&1; then
  for candidate in /opt/libreoffice*/program/soffice; do
    [ -x "$candidate" ] && ln -sf "$candidate" /usr/local/bin/soffice && break
  done
fi
command -v soffice >/dev/null 2>&1 || { echo "soffice is not on PATH after installing LibreOffice" >&2; exit 1; }
# Convert something, rather than just checking the binary is on PATH: a
# LibreOffice missing a shared library resolves fine as a path and fails only
# when the docx skill first tries to use it, which is far too late to find out.
lo_check="$(mktemp -d)"
printf 'sandbox image check' > "$lo_check/probe.txt"
# Guarded so a failing soffice does not trip `set -e` before the check below
# can say what went wrong; its stderr is kept for the same reason.
HOME="$lo_check" soffice --headless --convert-to pdf "$lo_check/probe.txt" --outdir "$lo_check" || true
[ -s "$lo_check/probe.pdf" ] || { echo "LibreOffice ${LO_VERSION} cannot convert a document" >&2; exit 1; }
rm -rf "$lo_check"

# --- Python packages ---
# amd64 installs the bundle's wheels verbatim and offline. arm64 has no x86_64
# wheels to install, so it resolves from PyPI under a constraints file built
# from those same wheels: same versions, including transitive ones, arch-correct
# binaries. Guest python is 3.11, so cp311 is the self-consistent selection.
python3 - "$BUNDLE/python-wheels" > /tmp/office-constraints.txt <<'PY'
import os, re, sys

# Pick, per distribution, the bundle wheel that pip would install on cp311:
# an exact cp311 build first, then a forward-compatible abi3 build (magika
# ships cp39-abi3, protobuf cp310-abi3 — miss these and arm64 silently
# resolves a newer version than the bundle proved), then a pure-python wheel.
def rank(pytag, abitag, plattag):
    if "cp311" in pytag:
        return 3
    if abitag == "abi3" and re.fullmatch(r"cp(\d+)", pytag) and int(pytag[2:]) <= 311:
        return 2
    # abi-less wheels, whether universal (py3-none-any) or platform-tagged
    # (magika ships py3-none-manylinux_x86_64). Only the version is taken from
    # these, so an x86_64 tag here still yields the right pin for arm64, where
    # pip picks that version's own aarch64-compatible wheel.
    if abitag == "none" and pytag.startswith("py"):
        return 1
    return 0

def version_key(version):
    return tuple(int(part) if part.isdigit() else 0 for part in re.split(r"[.\-+]", version))

best = {}
for name in os.listdir(sys.argv[1]):
    if not name.endswith(".whl"):
        continue
    dist, version, rest = name[:-4].split("-", 2)
    tags = rest.split("-")
    if len(tags) < 3:
        continue
    scored = rank(tags[-3], tags[-2], tags[-1])
    if not scored:
        continue
    key = dist.replace("_", "-").lower()
    if key not in best or (scored, version_key(version)) > best[key][0]:
        best[key] = ((scored, version_key(version)), version)
for key in sorted(best):
    print(f"{key}=={best[key][1]}")
PY
PIP_PACKAGES=(pandas openpyxl 'markitdown[pptx]' reportlab pypdf matplotlib)
if [ "$ARCH" = "amd64" ]; then
  pip3 install --break-system-packages --no-cache-dir \
    --no-index --find-links "$BUNDLE/python-wheels" "${PIP_PACKAGES[@]}"
else
  pip3 install --break-system-packages --no-cache-dir \
    -c /tmp/office-constraints.txt "${PIP_PACKAGES[@]}"
fi
rm -f /tmp/office-constraints.txt
python3 -c 'import pandas, openpyxl, markitdown, reportlab, pypdf, matplotlib, defusedxml'

# --- JS module trees ---
# Merged into one tree the way the setup script merges them under
# ~/.codev-office. Reached three ways on purpose, because each of the first two
# has a way to not be there: NODE_PATH in the guest env (the server exports it,
# so its shell tool inherits it — unless something along the way replaces the
# environment), an /etc/skel/.node_modules symlink (one of Node's global
# require() fallback folders — but only for a process whose HOME is a home the
# skel was copied into, which a root shell's /root is not), and
# /usr/local/lib/node below, which is the same fallback list without either
# dependency.
mkdir -p "$OFFICE_HOME/node_modules"
staging="$(mktemp -d)"
for mod_zip in "$BUNDLE"/*-node-modules.zip; do
  [ -f "$mod_zip" ] || continue
  unzip -q "$mod_zip" -d "$staging/current"
  [ -d "$staging/current/node_modules" ] && cp -R "$staging/current/node_modules/." "$OFFICE_HOME/node_modules/"
  rm -rf "$staging/current"
done
rm -rf "$staging"
mkdir -p /etc/skel
ln -sfn "$OFFICE_HOME/node_modules" /etc/skel/.node_modules
# $PREFIX/lib/node — the entry in Node's global fallback list that depends on
# neither the environment nor $HOME. Node derives it from its own binary
# (execPath/../../lib/node, so /usr/local/lib/node for the tarball install in
# the Dockerfile), which means require("pptxgenjs") resolves for any user, from
# any directory, with NODE_PATH unset. That is worth having even when the other
# two work: an agent that cannot require() the module goes looking for it, and
# `npm install -g pptxgenjs` cannot fix it either (npm -g installs into
# $PREFIX/lib/node_modules, which is NOT on require()'s search path) in a guest
# with no route off loopback.
#
# The fallback list is consulted only after the full node_modules walk-up, so a
# workspace project's own dependencies always win. The one behaviour this does
# change: a project MISSING a dependency the office tree happens to carry
# (react, react-dom) resolves it from here instead of failing.
mkdir -p /usr/local/lib
ln -sfn "$OFFICE_HOME/node_modules" /usr/local/lib/node

# Those trees are copied verbatim because they are pure JS — one build serves
# every arch. sharp (the pptx skill's react-icons -> SVG -> PNG path) is the
# exception: it loads a prebuilt libvips binary from an @img/sharp-<os>-<cpu>
# optional dependency, and the bundle carries the linux-x64 one. On arm64 that
# binary cannot load, so re-resolve it here exactly as every other
# arch-specific component in this file is handled — same version, arch-correct
# build. dpkg's arm64 is npm's arm64, and the Dockerfile refuses any arch that
# is not amd64 or arm64, so ARCH doubles as the --cpu value on this branch.
#
# Resolved in a scratch dir and copied in, NOT installed into the shared tree:
# `npm install` in a node_modules dir with no package.json reifies the tree
# from scratch and drops everything it cannot account for, which would take
# PptxGenJS and Playwright with it.
sharp_pkg="$OFFICE_HOME/node_modules/sharp/package.json"
if [ "$ARCH" != "amd64" ] && [ -f "$sharp_pkg" ]; then
  SHARP_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$sharp_pkg")"
  sharp_scratch="$(mktemp -d)"
  ( cd "$sharp_scratch" && npm init -y >/dev/null \
      && npm install --no-audit --no-fund --os=linux --cpu="$ARCH" --libc=glibc "sharp@$SHARP_VERSION" >/dev/null )
  # A silently-ignored --cpu yields a tree that looks right and throws only in
  # the guest, so require the binary package by name rather than trusting npm.
  [ -d "$sharp_scratch/node_modules/@img/sharp-linux-$ARCH" ] \
    || { echo "no @img/sharp-linux-$ARCH for sharp $SHARP_VERSION (npm >= 10 needed for --cpu)" >&2; exit 1; }
  rm -rf "$OFFICE_HOME/node_modules/@img"
  cp -R "$sharp_scratch/node_modules/." "$OFFICE_HOME/node_modules/"
  rm -rf "$sharp_scratch"
fi

# Use the trees rather than just checking they unpacked, the way the LibreOffice
# step converts a document instead of resolving a binary. They arrive by a
# wildcard glob, so a zip that failed to unpack, or a native binary built for
# the other arch, is otherwise invisible until an agent tries to build a deck.
#
# Deliberately run with NODE_PATH unset, from a directory with no relationship
# to the tree: that is the guest's worst case (a shell whose environment did not
# survive, in the user's workspace), so it is what the image should be proven
# against. Passing here means the /usr/local/lib/node fallback carries it alone.
office_node() { ( cd / && env -u NODE_PATH -u NODE_OPTIONS node -e "$1" ); }
if [ -d "$OFFICE_HOME/node_modules/pptxgenjs" ]; then
  office_node 'const P=require("pptxgenjs");const p=new P();p.layout="LAYOUT_16x9";p.addSlide().addText("image check",{x:1,y:1,w:8,h:1,fontSize:24});p.writeFile({fileName:"/tmp/office-check.pptx"}).then(function(){process.exit(0);}).catch(function(e){console.error(e);process.exit(1);});'
  python3 -m markitdown /tmp/office-check.pptx >/dev/null
  rm -f /tmp/office-check.pptx
fi
# Icons are optional per the skill's own docs, so this warns like the playwright
# steps below rather than failing the build: without them decks still come out
# of shapes, text and charts.
if [ -d "$OFFICE_HOME/node_modules/sharp" ]; then
  office_node 'const React=require("react"),RDS=require("react-dom/server"),sharp=require("sharp");const {FaCheckCircle}=require("react-icons/fa");const svg=RDS.renderToStaticMarkup(React.createElement(FaCheckCircle,{color:"#000000",size:"64"}));sharp(Buffer.from(svg)).png().toBuffer().then(function(b){process.exit(b.length?0:1);}).catch(function(e){console.error(e);process.exit(1);});' \
    || echo "warn: the pptx icon toolchain is unusable; react-icons artwork will be unavailable" >&2
fi

# --- Chromium for Playwright (pdf cover rendering) ---
# Playwright launches the browser build matching its own version, so the
# bundle ships the module tree and the browser together. That zip is an
# x86_64 build; on arm64 the bundled module installs its own matching browser.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
playwright_cli="$OFFICE_HOME/node_modules/playwright/cli.js"
if [ "$ARCH" = "amd64" ] && [ -f "$BUNDLE/ms-playwright-chromium.zip" ]; then
  unzip -q "$BUNDLE/ms-playwright-chromium.zip" -d "$PLAYWRIGHT_BROWSERS_PATH"
elif [ -f "$playwright_cli" ]; then
  NODE_PATH="$OFFICE_HOME/node_modules" node "$playwright_cli" install chromium
fi
# The browser binary alone is not enough on a slim Debian: without its shared
# libraries Chromium is present but cannot launch, which surfaces only at
# runtime as a failed pdf cover. Non-fatal like every other playwright step in
# the setup script — the rest of the pdf skill works without covers.
if [ -f "$playwright_cli" ]; then
  NODE_PATH="$OFFICE_HOME/node_modules" node "$playwright_cli" install-deps chromium \
    || echo "warn: playwright install-deps failed; pdf cover rendering may be unavailable" >&2
fi
ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium-* >/dev/null 2>&1 \
  || echo "warn: no chromium in $PLAYWRIGHT_BROWSERS_PATH; pdf cover rendering unavailable" >&2

# --- Offline NuGet feed ---
# Required, exactly as in the setup script: the docx skill's CLI restores
# DocumentFormat.OpenXml and friends from here, and a sealed sandbox has no
# route to nuget.org. The config clears nuget.org so a restore fails loudly
# rather than hanging on an unreachable host.
feed_src="$BUNDLE/nuget-offline-feed"
[ -d "$feed_src" ] || { echo "nuget-offline-feed not found in the bundle" >&2; exit 1; }
feed="$OFFICE_HOME/nuget-offline-feed"
mkdir -p "$feed" /etc/skel/.nuget/NuGet
cp "$feed_src"/*.nupkg "$feed/"
cat > /etc/skel/.nuget/NuGet/NuGet.Config <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="offline" value="$feed" />
  </packageSources>
</configuration>
EOF

# --- Skills ---
# Into a system path; the skel config below points every fresh home at it.
mkdir -p /opt/codev-skills
for skill_zip in "$BUNDLE"/*-skill.zip; do
  [ -f "$skill_zip" ] || continue
  name="$(basename "$skill_zip" .zip)"
  name="${name%-skill}"
  # Unzip through a staging dir and move the inner tree up, exactly as the
  # setup script does: the zips carry their own top-level <skill>/ directory,
  # so unzipping straight into the destination buries SKILL.md a level deeper
  # than the proven layout. Discovery survives that (its glob is recursive and
  # these skills name themselves in frontmatter), but a skill without a
  # frontmatter name would silently fail to load, since the filename fallback
  # only applies to a SKILL.md sitting directly in the configured directory.
  staging="$(mktemp -d)"
  unzip -q "$skill_zip" -d "$staging"
  rm -rf "/opt/codev-skills/$name"
  if [ -d "$staging/$name" ]; then
    mv "$staging/$name" "/opt/codev-skills/$name"
  else
    mv "$staging" "/opt/codev-skills/$name"
  fi
  rm -rf "$staging"
done
for required in minimax-docx minimax-xlsx; do
  [ -f "/opt/codev-skills/$required/SKILL.md" ] \
    || { echo "$required is missing or has no SKILL.md at its root" >&2; exit 1; }
done
mkdir -p /etc/skel/.config/codev
cat > /etc/skel/.config/codev/codev.json <<'JSON'
{
  "skills": {
    "paths": ["/opt/codev-skills"]
  }
}
JSON

# Env the guest boot paths source (vz init and the bwrap/wsl boot scripts).
cat > /etc/codev-guest.env <<ENV
export DOTNET_ROOT=/opt/dotnet
export NODE_PATH=$OFFICE_HOME/node_modules
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV

# Record what actually went in, so a built image can be audited without
# re-deriving versions from its filesystem.
cat > /etc/codev-office-versions <<ENV
dotnet=$DOTNET_VERSION
pandoc=$PANDOC_VERSION
libreoffice=$LO_VERSION
arch=$ARCH
ENV

rm -rf /var/lib/apt/lists/*

# The image build already populated /home/codev before this layer; re-apply
# skel so baked homes (vz disk) get the skills config, the NuGet config and
# the module link too.
cp -Rn /etc/skel/. /home/codev/ 2>/dev/null || true
chown -R codev:codev /home/codev
