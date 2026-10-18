{
  description = "Development shell and VSIX package for GitDiff";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_22;
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
          nativeTools = [ pkgs.pkg-config pkgs.python3 pkgs.gnumake ];
          nativeLibraries = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.libsecret ];
        in
        {
          packages = rec {
            default = vsix;
            vsix = pkgs.buildNpmPackage {
              pname = manifest.name;
              version = manifest.version;
              inherit nodejs;

              src = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = pkgs.lib.fileset.unions [
                  ./package.json
                  ./package-lock.json
                  ./tsconfig.json
                  ./.mocharc.json
                  ./.vscodeignore
                  ./README.md
                  ./src
                  ./test
                  ./icons
                ];
              };

              npmDeps = pkgs.importNpmLock {
                npmRoot = ./.;
              };
              npmConfigHook = (pkgs.callPackage (pkgs.path + "/pkgs/build-support/node/import-npm-lock/hooks") {
                inherit nodejs;
              }).npmConfigHook;
              nativeBuildInputs = nativeTools ++ [ pkgs.git ];
              buildInputs = nativeLibraries;

              # Build keytar against Nix's libraries instead of fetching a prebuilt addon.
              npm_config_build_from_source = "true";
              npmBuildScript = "package";
              # The bundle has no runtime npm dependencies. This repository has
              # no LICENSE file, so suppress VSCE's interactive license prompt.
              npmBuildFlags = [ "--" "--no-dependencies" "--skip-license" ];

              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm run test:unit
                runHook postCheck
              '';

              installPhase = ''
                runHook preInstall
                install -Dm644 ${manifest.name}-${manifest.version}.vsix \
                  "$out/${manifest.name}-${manifest.version}.vsix"
                runHook postInstall
              '';
            };
          };

          devShells.default = pkgs.mkShell {
            packages = [ nodejs pkgs.git pkgs.stdenv.cc ] ++ nativeTools;
            buildInputs = nativeLibraries;
            # Use the installed Node headers when compiling native npm dependencies.
            npm_config_nodedir = "${nodejs}";
            npm_config_build_from_source = "true";
          };
        };
    in
    {
      packages = forAllSystems (system: (forSystem system).packages);
      devShells = forAllSystems (system: (forSystem system).devShells);
    };
}
