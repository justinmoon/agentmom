{
  lib,
  modulesPath,
  self,
  ...
}:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    ../common/base.nix
    ./disk-config.nix
    self.nixosModules.prodHost
  ];

  # Decommissioning (todos/mom1-migration.md): prod moved to mom-stage-1 on
  # 2026-07-21. Keep the service off so a reboot cannot revive a second prod
  # (the telegram bot token only works on one host).
  services.agentmomWeb.enable = lib.mkForce false;

  boot.loader.grub = {
    enable = true;
    device = "/dev/nvme1n1";
    devices = lib.mkForce [ "/dev/nvme1n1" ];
    efiSupport = true;
    efiInstallAsRemovable = true;
  };
  boot.kernelParams = [ "net.ifnames=0" ];

  networking = {
    hostName = "mom-1";
    useDHCP = true;
    dhcpcd.extraConfig = "nohook hostname";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
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

  services.dbus.implementation = "dbus";

  age.identityPaths = [ "/etc/age/key.txt" ];
  age.secrets.agentmom-secrets = {
    file = ../../secrets/secrets.age;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  system.stateVersion = "25.05";
}
