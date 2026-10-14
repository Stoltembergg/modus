# Windows window appearance

The Windows 11 window uses Electron's native caption buttons and DWM Acrylic.
The user's Full, Sidebar and Off settings retain their existing CSS behavior.

## Native window configuration

- `frame: false`, `titleBarStyle: "hidden"` and `titleBarOverlay` keep native
  minimize, maximize/restore and close buttons over the application's titlebar.
- Both the overlay background and symbol colors are set at construction from
  the saved appearance, then updated when theme or transparency changes.
- `transparent: false`, `thickFrame: true` and `roundedCorners: true` retain
  the native resizable frame and Windows 11 corner rounding. Native DWM Acrylic
  provides the backdrop; Electron's layered transparent-window mode is not used.
- Acrylic is selected because background Acrylic reveals wallpaper and other
  windows. Mica is an opaque material that samples the wallpaper, so it does not
  provide the translucency advertised by Full and Sidebar.

Electron 44.5.1 explicitly disables the thick frame for `transparent: true` on
Windows, and disables rounded corners when that frame is absent. CSS rounding
would not fix that native-window configuration.

## Support and fallback

Electron's system backdrop API requires Windows 11 22H2 (build 22621) or newer.
Older Windows versions retain their system frame and solid surfaces. Windows 10
does not gain native Windows 11 corners through this change. Maximized windows
follow the operating system's edge treatment.

Off, reduced transparency and high contrast disable the effect. An exception
from the material API falls back to solid surfaces with readable caption buttons.
The Windows compositor can also substitute an opaque material (for example under
system performance/power policies). Electron's void material setter does not
report every native DWM failure to JavaScript, so a successful call is not proof
that the compositor actually displayed transparency.

## Validation boundary

Unit tests exercise the productive constructor and appearance controller,
including first-paint colors, theme changes, Off/Sidebar, exceptions and native
frame options. The Windows packaging job checks compilation and the built
renderer's glass layers in headless Chrome. Those checks do not validate DWM
pixels or interactive native caption buttons.

A Windows 11 desktop visual check still needs to confirm caption readability
in dark/light themes, minimize/maximize/restore/close, windowed corner rounding,
and another window visible through Full/Sidebar with OS transparency enabled.

References:

- [Electron 44.5.1 Windows frame and backdrop implementation](https://github.com/electron/electron/blob/v44.5.1/shell/browser/native_window_views.cc)
- [Microsoft Mica material](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
- [Microsoft Acrylic material](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)
