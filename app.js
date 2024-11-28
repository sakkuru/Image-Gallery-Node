const express = require('express');
const multer = require('multer');
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, ContainerClient } = require('@azure/storage-blob');
const dotenv = require('dotenv');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { format, addHours } = require('date-fns');
const { TableClient } = require('@azure/data-tables');

dotenv.config();

const app = express();
const upload = multer();

app.use(express.urlencoded({ extended: true }));
app.use('/styles', express.static(path.join(__dirname, 'public/styles')));
app.use('/scripts', express.static(path.join(__dirname, 'public/scripts')));


// Azure Storageの設定
const connectStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const tableName = "LikesTable";

if (!connectStr || !containerName) {
    console.error("Error: Azure Storage connection string or container name not found");
    process.exit(1);
}

let blobServiceClient;
let containerClient;
let tableClient;

try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectStr);
    containerClient = blobServiceClient.getContainerClient(containerName);
    tableClient = TableClient.fromConnectionString(connectStr, tableName);
    

} catch (error) {
    console.error(`Error connecting to Azure Blob Storage: ${error.message}`);
    process.exit(1);
}

function getBlobUrl(blobName) {
    const now = new Date();
    const expiryTime = addHours(now, 10);
    const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: 'r',
        expiresOn: expiryTime
    }, blobServiceClient.credential).toString();

    const blobUrl = `https://${blobServiceClient.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
    return blobUrl;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', async (req, res) => {
    try {
        const blobs = [];
        for await (const blob of containerClient.listBlobsFlat()) {
            blobs.push(blob);
        }

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
            blobUrls.push({
                name: blob.name,
                url: getBlobUrl(blob.name),
                likes: likes
            });
        }

        res.render('index', { blobs: blobUrls });
    } catch (error) {
        res.send(`Error retrieving blobs: ${error.message}`);
    }
});

app.post('/upload', upload.single('file'), async (req, res) => {
    console.log("Handling upload route");
    const file = req.file;
    if (file) {
        const extension = path.extname(file.originalname); // 元のファイル名から拡張子を取得
        const uniqueFilename = `${uuidv4()}${extension}`; // 拡張子を新しいファイル名に付与
        try {
            const blockBlobClient = containerClient.getBlockBlobClient(uniqueFilename);
            await blockBlobClient.uploadData(file.buffer);
            console.log(`Uploaded file: ${uniqueFilename}`);
        } catch (error) {
            return res.send(`Error uploading file: ${error.message}`);
        }
    }
    res.redirect('/');
});

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
        return res.send(`Error deleting blobs: ${error.message}`);
    }
    res.redirect('/');
});

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
