{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_24,
}:

buildNpmPackage {
  pname = "agentgranny2";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        base = baseNameOf path;
      in
      !(base == ".git"
        || base == ".direnv"
        || base == ".env"
        || base == ".agentgranny2"
        || base == ".smoke-workspace"
        || base == ".smoke-smolvm-workspace"
        || base == "dist"
        || base == "node_modules"
        || base == "projects"
        || base == "mutiny-wallet"
        || base == "index.ts"
        || base == "encode-event.ts"
        || base == "npm-debug.log");
  };

  nodejs = nodejs_24;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-s+C1aCG+aokXbNMm/nSIy4nVSiyy5DHM0kl0TflnNPg=";
  makeCacheWritable = true;

  nativeBuildInputs = [ makeWrapper ];

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/agentgranny2" "$out/bin"
    cp -R dist src package.json package-lock.json node_modules "$out/share/agentgranny2/"

    makeWrapper ${nodejs_24}/bin/node "$out/bin/agentgranny2" \
      --set NODE_ENV production \
      --chdir "$out/share/agentgranny2" \
      --add-flags "$out/share/agentgranny2/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$out/share/agentgranny2/src/server.ts"

    runHook postInstall
  '';

  meta = {
    description = "Lean Pi-backed Agent Granny web shell";
    mainProgram = "agentgranny2";
  };
}
