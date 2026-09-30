# MEMORY

## 项目工具约定
- `sd.sh`（markdown 加解密脚本）：加密用 PBKDF2 派生密钥；解密函数带 fallback，兼容旧格式（`key = SHA256(密钥串)`）。文件格式为 `salt:iv:base64` 单行。历史上曾有文件是旧版 SHA256 派生加密的（如 2026-09-29 的 sd.md）。
