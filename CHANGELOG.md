# Changelog

## v1.0.3

### Fixes and improvements

- Settings now preserve your history limits and custom shortcut after restarting.
- Fixed accidental history deletion or pasting while editing settings, and improved panel focus and shortcut behavior.
- Image cleanup now removes unused originals and thumbnails, including files left by older versions, while preserving images still in use.
- Improved clipboard capture during startup and declared the required Linux paste dependency in DEB/RPM packages.

Before upgrading, fully quit the old app. Do not run old and new versions at the same time.

### 修复与改进

- 历史记录保留设置和自定义快捷键在重启后正确恢复。
- 修复编辑设置时误删记录或误粘贴的问题，并改善面板焦点与快捷键操作。
- 自动清理不再使用的原图和缩略图，包括旧版本遗留的图片，同时保留仍在使用的图片。
- 改善启动时的剪贴板捕获，并为 Linux DEB/RPM 安装包声明必需的粘贴依赖。

升级前请完全退出旧版，不要同时运行新旧版本。

## v1.0.2

### New Features

- **Multi-Monitor Support**: Panel now appears on the monitor where your cursor is located
- **Fullscreen App Support**: Panel can now display over fullscreen applications on macOS (using NSPanel)
- **Auto-Paste**: Pressing Enter or clicking on a card now copies and automatically pastes to the previous app
- **Copy Only**: Use Cmd/Ctrl+C to copy without pasting

### 新功能

- **多显示器支持**：面板现在会显示在光标所在的显示器上
- **全屏应用支持**：面板现在可以在 macOS 全屏应用上显示（使用 NSPanel）
- **自动粘贴**：按回车或点击卡片会复制并自动粘贴到之前的应用
- **仅复制**：使用 Cmd/Ctrl+C 只复制不粘贴

## v1.0.1

### Bug Fixes

- **Auto-scroll**: Fixed issue where selected card could go out of view when navigating with arrow keys. Now the view automatically scrolls to keep the selected card visible.

### Improvements

- **Performance**: Optimized card refs management for better performance during frequent copy operations.

### 问题修复

- **自动滚动**：修复了使用方向键导航时，选中的卡片可能超出可视区域的问题。现在视图会自动滚动以保持选中卡片可见。

### 优化

- **性能优化**：优化了卡片引用管理，提升频繁复制操作时的性能。

## v1.0.0

Initial release / 首次发布
