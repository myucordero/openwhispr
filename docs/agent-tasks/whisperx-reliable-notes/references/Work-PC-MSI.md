# Work PC — MSI System Inventory

Collected: 2026-07-16 17:28:14 -04:00

This report was generated from the local Windows WMI/CIM hardware and operating-system inventory. Credentials, product keys, Windows activation identifiers, and user-account details are intentionally omitted.

## Summary

| Component | Details |
|---|---|
| Manufacturer / model | Micro-Star International Co., Ltd. — Raider GE68HX 13VF |
| System type | x64-based PC; mobile system |
| Operating system | Microsoft Windows 11 Home, 64-bit, build 26200 |
| CPU | 13th Gen Intel Core i9-13950HX; 24 cores / 32 logical processors |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU; Intel UHD Graphics |
| Memory | 31.71 GB usable physical memory reported; 2 × 16 GB DDR5-5600 SO-DIMM |
| Storage | 953.86 GB NVMe Micron 2400; C: volume has 930.36 GB total / 356.15 GB free |
| Active display | 1920 × 1200 at 144 Hz |
| Battery | 94% charge reported; battery status code 2 |

## Computer

| Property | Value |
|---|---|
| Manufacturer | Micro-Star International Co., Ltd. |
| Model | Raider GE68HX 13VF |
| System type | x64-based PC |
| Total physical memory | 31.71 GB |
| Physical processors | 1 |
| Logical processors | 32 |
| PC system type | 2 — mobile |

## CPU

| Property | Value |
|---|---|
| Name | 13th Gen Intel(R) Core(TM) i9-13950HX |
| Manufacturer | GenuineIntel |
| Cores | 24 |
| Logical processors | 32 |
| Maximum clock reported | 2200 MHz |
| Current clock reported | 2200 MHz |
| L2 cache | 32,768 KB |
| L3 cache | 36,864 KB |
| Socket | U3E1 |
| Status | OK |
| WMI description | Intel64 Family 6 Model 183 Stepping 1 |

## GPU / graphics

| Adapter | Video processor | Adapter RAM reported | Driver | Driver date | Current mode | Status |
|---|---|---:|---|---|---|---|
| NVIDIA GeForce RTX 4060 Laptop GPU | NVIDIA GeForce RTX 4060 Laptop GPU | 4.00 GB | 32.0.15.9579 | 2026-03-03 | 1920 × 1080 at 60 Hz | OK |
| Intel(R) UHD Graphics | Intel(R) RaptorLake-S Mobile Graphics Controller | 2.00 GB | 32.0.101.6129 | 2024-10-17 | 1920 × 1200 at 144 Hz | OK |

The adapter RAM values are the values reported by WMI; integrated-graphics memory can be dynamically shared with system memory.

## Memory modules

| Slot | Capacity | Speed | Configured speed | Manufacturer | Part number | Form factor code | Memory type code |
|---|---:|---:|---:|---|---|---:|---:|
| Controller0-ChannelA-DIMM0 | 16 GB | 5600 MHz | 5600 MHz | SK Hynix | HMCG78AGBSA095N | 12 — SO-DIMM | 0 — unknown |
| Controller1-ChannelA-DIMM0 | 16 GB | 5600 MHz | 5600 MHz | SK Hynix | HMCG78AGBSA095N | 12 — SO-DIMM | 0 — unknown |

## Physical storage

| Device | Model | Interface reported | Media type | Capacity | Firmware | Status |
|---|---|---|---|---:|---|---|
| \\\\.\\PHYSICALDRIVE0 | NVMe Micron_2400_MTFDKBA1T0QFM | SCSI (WMI classification) | Fixed hard disk media | 953.86 GB | V3MA001 | OK |

## Volumes

| Drive | Label | File system | Total | Used | Free |
|---|---|---|---:|---:|---:|
| C: | Windows | NTFS | 930.36 GB | 574.21 GB | 356.15 GB |

## Motherboard and BIOS

| Property | Value |
|---|---|
| Motherboard manufacturer | Micro-Star International Co., Ltd. |
| Motherboard product | MS-15M2 |
| Motherboard version | REV:1.0 |
| BIOS manufacturer | American Megatrends International, LLC. |
| SMBIOS BIOS version | E15M2IMS.112 |
| BIOS version string | MSI_NB - 1072009 |
| BIOS release date | 2024-09-24 |

## Operating system

| Property | Value |
|---|---|
| Edition | Microsoft Windows 11 Home |
| Version | 10.0.26200 |
| Build | 26200 |
| Architecture | 64-bit |
| Install date | 2025-08-04 08:28:52 |
| Last boot | 2026-07-16 08:14:29 |
| Windows directory | `C:\WINDOWS` |
| System directory | `C:\WINDOWS\system32` |
| Locale | 0409 |
| Installed UI languages | en-US, es-MX |

## Network adapters

Connection status values are the Windows WMI values: `2` = connected, `7` = media disconnected, and `0` = disconnected/not connected.

| Adapter | Manufacturer | Type | Link speed reported | Connection | Status | MAC address |
|---|---|---|---:|---|---:|---|
| Intel(R) Wi-Fi 6E AX211 160MHz | Intel Corporation | Ethernet 802.3 | 785.21 Mbps | Wi-Fi | 2 — connected | 74:3A:F4:C6:0B:0B |
| Killer E3100G 2.5 Gigabit Ethernet Controller | Killer | Ethernet 802.3 | 953.67 Mbps | Ethernet | 7 — media disconnected | D8:43:AE:07:8A:F4 |
| Fortinet Virtual Ethernet Adapter (NDIS 6.30) | Fortinet | Ethernet 802.3 | 95.37 Mbps | Ethernet 2 | 7 — media disconnected | 00:09:0F:FE:00:01 |
| Fortinet SSL VPN Virtual Ethernet Adapter | Fortinet Inc | — | — | Ethernet 3 | 0 — disconnected | — |
| OpenVPN Data Channel Offload | OpenVPN, Inc | — | 953.67 Mbps | OpenVPN Data Channel Offload for Surfshark | 7 — media disconnected | — |

### Active IP configuration

| Adapter | DHCP | IPv4 | IPv6 | Default gateway | DNS servers |
|---|---|---|---|---|---|
| Intel(R) Wi-Fi 6E AX211 160MHz | Enabled | 172.16.10.106 | fe80::2b52:ab5e:f7d4:3896 | 172.16.10.1 | 172.16.10.45; 8.8.8.8; 1.1.1.1 |

## Displays

| Display | Type | Reported resolution | Scaling |
|---|---|---|---|
| Default Monitor | Default Monitor | Not reported | 120 × 120 logical DPI |
| Generic PnP Monitor | Generic PnP Monitor | 1920 × 1200 | 120 × 120 logical DPI |

The active graphics adapter reports a current mode of 1920 × 1200 at 144 Hz for the Intel UHD Graphics adapter and 1920 × 1080 at 60 Hz for the NVIDIA adapter.

## Audio devices

| Device | Manufacturer | Status |
|---|---|---|
| Intel Smart Sound Technology for Bluetooth Audio | Intel Corporation | OK |
| Intel Smart Sound Technology for USB Audio | Intel Corporation | OK |
| NVIDIA High Definition Audio | NVIDIA | OK |
| Intel Smart Sound Technology for Digital Microphones | Intel Corporation | OK |
| USB Audio Device | Generic USB Audio | OK |
| NVIDIA Virtual Audio Device (Wave Extensible) (WDM) | NVIDIA | OK |
| Realtek High Definition Audio | Realtek | OK |
| Nahimic Easy Surround device | Nahimic | OK |
| Nahimic mirroring device | Nahimic | OK |
| SteelSeries Sonar Virtual Audio Device | SteelSeries ApS | OK |

## Battery

| Property | Value |
|---|---|
| Battery name | BIF0_9 |
| Design voltage | 16,657 mV |
| Estimated charge remaining | 94% |
| Battery status | 2 — charging/active according to the WMI status code |
| Design capacity | Not reported by WMI |
| Full-charge capacity | Not reported by WMI |

## Recent Windows hotfixes

| Hotfix | Installed | Description |
|---|---|---|
| KB5100998 | 2026-07-15 | Update |
| KB5101650 | 2026-07-15 | Security Update |
| KB5120102 | 2026-07-15 | Security Update |
| KB5094135 | 2026-06-10 | Security Update |
| KB5054156 | 2025-11-03 | Update |

## Collection notes

- Values are Windows WMI/CIM-reported values at collection time and may differ from vendor specifications or dynamic runtime values.
- The physical disk is reported by WMI with interface type `SCSI`, which is a common Windows classification for an NVMe device.
- The report includes local network interface and active IP information because it was requested as a complete PC inventory. Treat this file as private.
