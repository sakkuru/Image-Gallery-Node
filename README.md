# Image Gallery on Azure

このアプリは Express + Azure Blob Storage + Table Storage を使用した画像共有・「いいね」ギャラリーです  
Entra ID (Managed Identity) による認証を利用し、ファイルのアップロード・表示・削除・いいね数の保存が可能です

---

## 🔧 必要環境

- Node.js 18+
- Azure CLI
- Azure サブスクリプション
- az login 済み

---

## 🚀 デプロイ手順（Azure App Service）

1. このリポジトリをクローン

```bash
git clone https://github.com/sakkuru/Image-Gallery-Node.git
cd Image-Gallery-Node
```

2. デプロイスクリプトを実行

```bash
chmod +x deploy.sh
./deploy.sh
```
Azure リソース（App Service, Storage, RBAC権限）が自動で作成され、アプリがデプロイされます
