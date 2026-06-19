{
  autoPatchelfHook,
  e2fsprogs,
  fetchurl,
  file,
  go-containerregistry,
  gnutar,
  lib,
  makeWrapper,
  stdenv,
}:

let
  version = "1.1.1";
  sources = {
    aarch64-linux = {
      suffix = "linux-arm64";
      hash = "sha256-J5BFB6NqRXFUmbGmH73ztkaBZeKJh1owEYwIY+uCzvM=";
    };
    x86_64-linux = {
      suffix = "linux-x86_64";
      hash = "sha256-7pn6ibMcWN1uiWK3BrXzK5PTBXdlfC9liNWJWRIWROs=";
    };
  };
  source =
    sources.${stdenv.hostPlatform.system}
      or (throw "smolvm ${version} release is not available for ${stdenv.hostPlatform.system}");
  releaseName = "smolvm-${version}-${source.suffix}";
in
stdenv.mkDerivation {
  pname = "smolvm";
  inherit version;

  src = fetchurl {
    url = "https://github.com/smol-machines/smolvm/releases/download/v${version}/${releaseName}.tar.gz";
    inherit (source) hash;
  };

  sourceRoot = releaseName;

  nativeBuildInputs = [ makeWrapper autoPatchelfHook ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/share/smolvm"
    cp -R . "$out/share/smolvm/"
    chmod -R u+w "$out/share/smolvm"

    makeWrapper "$out/share/smolvm/smolvm-bin" "$out/bin/smolvm" \
      --set SMOLVM_AGENT_ROOTFS "$out/share/smolvm/agent-rootfs" \
      --set SMOLVM_LIB_DIR "$out/share/smolvm/lib" \
      --prefix PATH : ${lib.makeBinPath [ e2fsprogs file go-containerregistry gnutar ]} \
      --prefix LD_LIBRARY_PATH : "$out/share/smolvm/lib"

    runHook postInstall
  '';

  meta = {
    description = "OCI-native microVM runtime";
    homepage = "https://github.com/smol-machines/smolvm";
    license = lib.licenses.asl20;
    mainProgram = "smolvm";
    platforms = builtins.attrNames sources;
  };
}
