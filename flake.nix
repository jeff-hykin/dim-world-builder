{
    description = "dim-world-builder: build worlds for simulated robots and export them for dimos sim2, as a dimOS Desktop app (`nix build .#dimosApp`)";
    # nixos-25.11's deno is 2.6.10, the version dimos pins for its cockpit
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };
    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
            files = pkgs: paths: pkgs.lib.fileset.toSource { root = ./.; fileset = pkgs.lib.fileset.unions paths; };
            # the server's start line: deno for the server, uv for the cooker (it fetches its own CPython and the locked
            # wheels into the app's data folder on the first import, so nothing here is platform-specific but the binaries)
            serverLine = target: server: frontend: ''
                export PATH=${target.uv}/bin:$PATH
                exec ${target.deno}/bin/deno run -A --no-lock ${server}/backend/main.ts --frontend ${frontend} --uv ${target.uv}/bin/uv "$@"
            '';
            # bin/dimos-app-server for <arch> Linux, written on any machine: its bash, deno and uv are the target's
            linuxApp = pkgs: arch: server: frontend:
                let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                pkgs.writeTextFile {
                    name = "dimos-app-server-${arch}-linux";
                    destination = "/bin/dimos-app-server";
                    executable = true;
                    text = "#!${linux.runtimeShell}\n${serverLine linux server frontend}\n";
                };
        in {
            packages = forAll (pkgs:
                let
                    denoEnv = "export HOME=$TMPDIR DENO_DIR=$TMPDIR/deno DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1";
                    # `deno install --frozen` (deno.lock pins every package) with network, so fixed-output. Its hash is per
                    # build machine (vite's native rollup and esbuild differ by OS and CPU): `deno task update-hashes` refreshes
                    # this machine's after deno.json or deno.lock change.
                    frontendModules = pkgs.stdenvNoCC.mkDerivation {
                        name = "dim-world-builder-frontend-modules";
                        src = files pkgs [ ./deno.json ./deno.lock ];
                        nativeBuildInputs = [ pkgs.deno ];
                        buildPhase = ''
                            ${denoEnv}
                            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                            deno install --frozen
                            # deno's own record of the install: not needed, and not byte-identical between installs
                            rm -f node_modules/.deno/.setup-cache.bin
                        '';
                        installPhase = "cp -R node_modules $out";
                        dontFixup = true;
                        outputHashMode = "recursive";
                        outputHashAlgo = "sha256";
                        outputHash = {
                            aarch64-darwin = "sha256-38Ew3qwupjrYF18qXYnDoDst1Cc3AwNiLIbkZRI9glA=";
                            x86_64-darwin = "";
                            x86_64-linux = "sha256-/VZfnn9Y9RtseSP37OHn6EFBakoUM0kwEv+lyzqrV6Y=";
                            aarch64-linux = "sha256-T81IQRFu/s9xl66LxPpZQbyiw166CaX5+4K7KVIbXXw=";
                        }.${pkgs.stdenv.hostPlatform.system};
                    };

                    pageFiles = files pkgs [ ./deno.json ./deno.lock ./index.html ./vite.config.ts ./tsconfig.json ./tools/esm_fetch.ts ./src ];
                    # dimos-react as esm.sh builds its tag (tools/esm_fetch.ts): a vite build with network that
                    # keeps only what it fetched, so fixed-output; the same on every system. `deno task update-hashes` refreshes it.
                    frontendEsm = pkgs.stdenvNoCC.mkDerivation {
                        name = "dim-world-builder-frontend-esm";
                        src = pageFiles;
                        nativeBuildInputs = [ pkgs.deno ];
                        buildPhase = ''
                            ${denoEnv}
                            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
                            cp -R ${frontendModules} node_modules
                            chmod -R u+w node_modules
                            ESM_CACHE=$TMPDIR/esm deno run -A --cached-only --node-modules-dir=manual npm:vite build --logLevel warn
                        '';
                        installPhase = "cp -R $TMPDIR/esm $out";
                        dontFixup = true;
                        outputHashMode = "recursive";
                        outputHashAlgo = "sha256";
                        outputHash = "sha256-7aHVZWHja8ajIkhsYWAj72wjqyRp5D+QaSGPFUXceOs=";
                    };

                    # the page: React + Vite against those modules and that esm.sh cache, offline (plain JS once built, so one build serves every target)
                    frontend = pkgs.stdenvNoCC.mkDerivation {
                        name = "dim-world-builder-frontend";
                        src = pageFiles;
                        nativeBuildInputs = [ pkgs.deno ];
                        buildPhase = ''
                            ${denoEnv}
                            cp -R ${frontendModules} node_modules
                            chmod -R u+w node_modules
                            ESM_CACHE=${frontendEsm} ESM_OFFLINE=1 deno run -A --cached-only --node-modules-dir=manual npm:vite build
                        '';
                        installPhase = "cp -R dist $out";
                    };
                in
                rec {
                inherit frontend frontendModules frontendEsm;
                # the server and what it reads: the shared world model, the asset library, the cooker's locked project
                server = files pkgs [ ./backend ./src/world ./assets ./cooker/pyproject.toml ./cooker/uv.lock ./cooker/cook.py ./cooker/render_view.py ./cooker/check_clips.py ];
                dimosApp = pkgs.writeShellScriptBin "dimos-app-server" (serverLine pkgs server frontend);
                default = dimosApp;
                dimosApp-aarch64-linux = linuxApp pkgs "aarch64" server frontend;
                dimosApp-x86_64-linux = linuxApp pkgs "x86_64" server frontend;
            });
        };
}
