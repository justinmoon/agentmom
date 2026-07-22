{
  config,
  lib,
  modulesPath,
  self,
  ...
}:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    (modulesPath + "/profiles/qemu-guest.nix")
    ../common/base.nix
    ./disk-config.nix
    self.nixosModules.prodHost
  ];

  # This box doubles as the shared VM-runner substrate ("compute"): jiggy's
  # forge drives CI microVMs here via agent-vm's v (~/code/agent-vm,
  # synced by git push from the mac; ~/configs likewise).
  users.users.justin.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINFsR0IWebrunalEymjnDio+1MV0Sfp04b9qTHGQCrlw forge@lab"
  ];

  boot.loader.grub = {
    enable = true;
    device = "/dev/disk/by-id/nvme-eui.00000000000000018ce38e05001f1973";
    devices = lib.mkForce [ "/dev/disk/by-id/nvme-eui.00000000000000018ce38e05001f1973" ];
    efiSupport = false;
  };
  boot.kernelParams = [ "net.ifnames=0" ];

  networking = {
    hostName = "mom-stage-1";
    useDHCP = true;
    firewall = {
      enable = true;
      allowPing = true;
      allowedTCPPorts = [ 22 ];
      interfaces.tailscale0 = {
        allowedTCPPorts = [ 22 7392 ];
        allowedTCPPortRanges = [
          {
            from = 41000;
            to = 41999;
          }
        ];
      };
    };
  };

  services.tailscale.useRoutingFeatures = "client";

  age.identityPaths = [ "/etc/age/key.txt" ];
  age.secrets.agentmom-secrets = {
    file = ../../secrets/secrets.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };
  age.secrets.fly-api-token = {
    file = ../../secrets/fly-api-token.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  services.agentmomWeb.flyTokenFile = config.age.secrets.fly-api-token.path;

  system.stateVersion = "25.05";
}
