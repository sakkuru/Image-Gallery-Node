#!/bin/bash

set -e

### ユーザー設定（必要に応じて変更）
RESOURCE_GROUP="ImageUploader"
LOCATION="japaneast"
APP_NAME="myapp$RANDOM"
STORAGE_ACCOUNT_NAME="mystorage$RANDOM"
PLAN_NAME="myAppPlan"
NODE_VERSION="18-lts"
CONTAINER_NAME="uploads"
TABLE_NAME="LikesTable"

echo "[1/9] リソースグループ作成"
az group create --name $RESOURCE_GROUP --location $LOCATION

echo "[2/9] ストレージアカウント作成"
az storage account create \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --sku Standard_LRS \
  --kind StorageV2

echo "[3/9] Blob コンテナ作成"
az storage container create \
  --name $CONTAINER_NAME \
  --account-name $STORAGE_ACCOUNT_NAME \
  --auth-mode login

echo "[4/9] App Service プラン作成"
az appservice plan create \
  --name $PLAN_NAME \
  --resource-group $RESOURCE_GROUP \
  --sku B1 \
  --is-linux

echo "[5/9] Web アプリ作成"
az webapp create \
  --resource-group $RESOURCE_GROUP \
  --plan $PLAN_NAME \
  --name $APP_NAME \
  --runtime "NODE|$NODE_VERSION" \
  --deployment-local-git

echo "[6/9] Managed Identity 有効化"
az webapp identity assign \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP

PRINCIPAL_ID=$(az webapp show \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query identity.principalId \
  --output tsv)

SUBSCRIPTION_ID=$(az account show --query id --output tsv)
STORAGE_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT_NAME"


# Wait for Managed Identity to be fully registered in Entra ID
echo "⏳ Managed Identity 登録待機中..."

for i in {1..10}; do
  if az ad sp show --id $PRINCIPAL_ID &>/dev/null; then
    echo "✅ Managed Identity が Entra ID に登録された"
    break
  fi
  echo "🔄 試行 $i: 登録待ち..."
  sleep 5
done

# 失敗していたら終了
if ! az ad sp show --id $PRINCIPAL_ID &>/dev/null; then
  echo "❌ Managed Identity が見つかりません（Entra ID に未反映）"
  exit 1
fi


echo "[7/9] RBAC権限付与（Blob / Table）"
az role assignment create \
  --assignee $PRINCIPAL_ID \
  --role "Storage Blob Data Contributor" \
  --scope $STORAGE_SCOPE

az role assignment create \
  --assignee $PRINCIPAL_ID \
  --role "Storage Table Data Contributor" \
  --scope $STORAGE_SCOPE

echo "[8/9] アプリ設定（環境変数）"
az webapp config appsettings set \
  --resource-group $RESOURCE_GROUP \
  --name $APP_NAME \
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true \
             AZURE_STORAGE_ACCOUNT_NAME=$STORAGE_ACCOUNT_NAME \
             AZURE_STORAGE_CONTAINER_NAME=$CONTAINER_NAME \
             PORT=3000

echo "[9/9] Git デプロイ"

zip -r app.zip . -x "*.git*" -x "node_modules/*"

az webapp deploy \
  --resource-group $RESOURCE_GROUP \
  --name $APP_NAME \
  --src-path app.zip \
  --type zip

echo "🎉 ZIPデプロイ完了: https://$APP_NAME.azurewebsites.net"