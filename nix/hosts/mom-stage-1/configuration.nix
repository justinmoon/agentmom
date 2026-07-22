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

  # 62G host: keep per-workspace VM ceilings well below physical memory.
  services.agentmomWeb.smolvm.memoryMb = 4096;

  system.stateVersion = "25.05";
}
