const express = require('express');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { format, addHours } = require('date-fns');

const { DefaultAzureCredential } = require('@azure/identity');
const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters } = require('@azure/storage-blob');

dotenv.config();

const app = express();
const upload = multer();

// テンプレートエンジンと静的ファイル
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use('/styles', express.static(path.join(__dirname, 'public/styles')));
app.use('/scripts', express.static(path.join(__dirname, 'public/scripts')));

// 環境変数の確認
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const tableName = "LikesTable";

if (!accountName || !containerName) {
    console.error("Error: Azure Storage account name or container name not found");
    process.exit(1);
}

// DefaultAzureCredentialでEntra ID認証を行う
// (Managed IdentityやService Principalなどで利用可能)
const credential = new DefaultAzureCredential();

// Blob操作用のクライアントを作成
const blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
);
const containerClient = blobServiceClient.getContainerClient(containerName);

// Table操作用のクライアントを作成
const tableClient = new TableClient(
    `https://${accountName}.table.core.windows.net`,
    tableName,
    credential
);

// 必要に応じてテーブルを作成（既にある場合のエラーは無視）
(async () => {
    try {
        await tableClient.createTable();
    } catch (error) {
        if (error.code !== 'TableAlreadyExists') {
            console.error("Error creating table:", error.message);
            process.exit(1);
        }
    }
})();

// BlobのSAS URLを生成する関数
// Azure AD認証の場合はUser Delegation Keyを用いる
async function getBlobUrl(blobName) {
    const now = new Date();
    const expiresOn = addHours(now, 10);
    const userDelegationKey = await blobServiceClient.getUserDelegationKey(now, expiresOn);

    // Blobへの読み取り権限を付与してSASを生成
    const sasToken = generateBlobSASQueryParameters(
        {
            containerName: containerName,
            blobName: blobName,
            permissions: BlobSASPermissions.parse('r'), // 読み取りのみ
            startsOn: now,
            expiresOn: expiresOn
        },
        userDelegationKey,
        accountName
    ).toString();

    const blobUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
    return blobUrl;
}

// GET: indexページ
app.get('/', async (req, res) => {
    try {
        const blobs = [];
        for await (const blob of containerClient.listBlobsFlat()) {
            blobs.push(blob);
        }

        // ファイル名でソート(逆順)
        blobs.sort((a, b) => b.name.localeCompare(a.name));

        const blobUrls = [];
        for (const blob of blobs) {
            let likes = 0;
            try {
                const entity = await tableClient.getEntity('Likes', blob.name);
                likes = parseInt(entity.likes);
            } catch (error) {
                if (error.statusCode !== 404) {
                    throw error;
                }
            }
            const url = await getBlobUrl(blob.name);
            blobUrls.push({
                name: blob.name,
                url: url,
                likes: likes
            });
        }

        res.render('index', { blobs: blobUrls });
    } catch (error) {
        console.error(error.message);
        res.send(`Error retrieving blobs\n${error.message}`);
    }
});

// POST: ファイルアップロード
app.post('/upload', upload.single('file'), async (req, res) => {
    console.log("Handling upload route");

    const file = req.file;
    if (file) {
        const extension = path.extname(file.originalname);
        const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
        const uniqueFilename = `${timestamp}_${uuidv4()}${extension}`;

        try {
            const blockBlobClient = containerClient.getBlockBlobClient(uniqueFilename);
            await blockBlobClient.uploadData(file.buffer);
            console.log(`Uploaded file: ${uniqueFilename}`);
        } catch (error) {
            console.error(`Error uploading file: ${error.message}`);
            return res.send(`Error uploading file\n${error.message}`);
        }
    }

    res.redirect('/');
});

// POST: 削除
app.post('/delete', async (req, res) => {
    console.log("Handling delete route");
    let blobNames = req.body.blob_names;
    if (!Array.isArray(blobNames)) {
        blobNames = [blobNames];
    }
    try {
        for (const blobName of blobNames) {
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            await blockBlobClient.delete();
            console.log(`Deleted blob: ${blobName}`);
        }
    } catch (error) {
        console.error(`Error deleting blobs: ${error.message}`);
        return res.send(`Error deleting blobs\n${error.message}`);
    }

    res.redirect('/');
});

// POST: いいね
app.post('/like/:blobName', async (req, res) => {
    const blobName = req.params.blobName;
    console.log("Like!", blobName);

    try {
        // エンティティの取得または作成
        let entity;
        try {
            entity = await tableClient.getEntity('Likes', blobName);
            entity.likes = parseInt(entity.likes) + 1;
        } catch (error) {
            if (error.statusCode === 404) {
                entity = { partitionKey: 'Likes', rowKey: blobName, likes: 1 };
            } else {
                throw error;
            }
        }

        // エンティティをアップサート
        await tableClient.upsertEntity(entity);

        res.json({ success: true, likes: entity.likes });
    } catch (error) {
        console.error(`Error updating likes for ${blobName}: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
