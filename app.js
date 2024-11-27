const express = require('express');
const multer = require('multer');
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, ContainerClient } = require('@azure/storage-blob');
const dotenv = require('dotenv');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { format, addHours } = require('date-fns');

dotenv.config();

const app = express();
const upload = multer();

// Azure Blob Storageの設定
const connectStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

if (!connectStr || !containerName) {
    console.error("Error: Azure Storage connection string or container name not found");
    process.exit(1);
}

let blobServiceClient;
let containerClient;

try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectStr);
    containerClient = blobServiceClient.getContainerClient(containerName);
} catch (error) {
    console.error(`Error connecting to Azure Blob Storage: ${error.message}`);
    process.exit(1);
}

function getBlobUrl(blobName) {
    const now = new Date();
    const expiryTime = addHours(now, 1);
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
        blobs.sort((a, b) => b.properties.createdOn - a.properties.createdOn);
        const blobUrls = blobs.map(blob => ({
            name: blob.name,
            url: getBlobUrl(blob.name)
        }));
        res.render('index', { blobs: blobUrls });
    } catch (error) {
        res.send(`Error retrieving blobs: ${error.message}`);
    }
});

app.post('/upload', upload.single('file'), async (req, res) => {
    console.log("Handling upload route");
    const file = req.file;
    if (file) {
        const filename = path.basename(file.originalname);
        const uniqueFilename = `${uuidv4()}`;
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
    const blobNames = req.body.blob_names;
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
