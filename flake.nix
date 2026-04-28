{
  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils = {
      url = "github:numtide/flake-utils";
    };
  };

  outputs = { self, flake-utils, fenix, nixpkgs }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system; overlays = [
          fenix.overlays.default
        ];
        };
      in
      {
        devShell = pkgs.mkShell {
          LD_LIBRARY_PATH = "${pkgs.stdenv.cc.cc.lib}/lib";
          buildInputs = with pkgs; [
            (pkgs.fenix.complete.withComponents [
              "cargo"
              "clippy"
              "rust-src"
              "rustc"
              "rustfmt"
            ])
            rust-analyzer-nightly
            clang
            pkg-config
            jq
          ];
        };
      }
    ));
}
