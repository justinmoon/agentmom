set dotenv-load := false

dev:
    nix develop -c npm run dev

install:
    nix develop -c npm install

build:
    nix develop -c npm run build

typecheck:
    nix develop -c npm run typecheck

smoke-local:
    nix develop -c npm run smoke:local
