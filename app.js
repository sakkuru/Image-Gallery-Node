const express = require('express')
const multer = require('multer')
const path = require('path')
const dotenv = require('dotenv')
const { v4: uuidv4 } = require('uuid')
const { format, addHours } = require('date-fns')

const { DefaultAzureCredential } = require('@azure/identity')
const { TableClient } = require('@azure/data-tables')
const {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters
} = require('@azure/storage-blob')

dotenv.config()

const app = express()
const upload = multer()

// EJSテンプレート設定と静的ファイルのルーティング
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.use(express.urlencoded({ extended: true }))
app.use('/styles', express.static(path.join(__dirname, 'public/styles')))
app.use('/scripts', express.static(path.join(__dirname, 'public/scripts')))

// 環境変数からストレージ情報を取得
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME
const tableName = 'LikesTable'

if (!accountName || !containerName) {
  console.error('Azureのストレージ設定が不足')
  process.exit(1)
}

// Azure認証と各種クライアントの初期化
const credential = new DefaultAzureCredential()
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential
)
const containerClient = blobServiceClient.getContainerClient(containerName)
const tableClient = new TableClient(
  `https://${accountName}.table.core.windows.net`,
  tableName,
  credential
)

// テーブルが存在しない場合のみ作成（既に存在している場合は無視）
;(async () => {
  try {
    await tableClient.createTable()
  } catch (error) {
    if (error.code !== 'TableAlreadyExists') {
      console.error('テーブル作成エラー:', error.message)
      process.exit(1)
    }
  }
})()

// Blobの一時公開URLを生成する関数（User Delegation Keyを使用）
async function getBlobUrl(blobName) {
  const now = new Date()
  const expiresOn = addHours(now, 10)
  const userDelegationKey = await blobServiceClient.getUserDelegationKey(now, expiresOn)

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: now,
      expiresOn
    },
    userDelegationKey,
    accountName
  ).toString()

  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`
}

// GET: メインページ表示。Blob一覧とLike数を取得
app.get('/', async (req, res) => {
  try {
    const blobs = []
    for await (const blob of containerClient.listBlobsFlat()) {
      blobs.push(blob)
    }

    // 名前降順でソート（新しいファイルを上に）
    blobs.sort((a, b) => b.name.localeCompare(a.name))

    const blobUrls = []
    for (const blob of blobs) {
      let likes = 0
      try {
        const entity = await tableClient.getEntity('Likes', blob.name)
        likes = parseInt(entity.likes)
      } catch (error) {
        if (error.statusCode !== 404) throw error
      }

      const url = await getBlobUrl(blob.name)
      blobUrls.push({ name: blob.name, url, likes })
    }

    res.render('index', { blobs: blobUrls })
  } catch (error) {
    console.error('Blob取得エラー:', error.message)
    res.send(`エラーが発生\n${error.message}`)
  }
})

// POST: ファイルアップロード処理
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return res.redirect('/')

  const extension = path.extname(file.originalname)
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const uniqueFilename = `${timestamp}_${uuidv4()}${extension}`

  try {
    const blockBlobClient = containerClient.getBlockBlobClient(uniqueFilename)
    await blockBlobClient.uploadData(file.buffer)
    console.log(`アップロード完了: ${uniqueFilename}`)
  } catch (error) {
    console.error('アップロードエラー:', error.message)
    return res.send(`アップロード失敗\n${error.message}`)
  }

  res.redirect('/')
})

// POST: Blob削除処理
app.post('/delete', async (req, res) => {
  let blobNames = req.body.blob_names
  if (!Array.isArray(blobNames)) {
    blobNames = [blobNames]
  }

  try {
    for (const blobName of blobNames) {
      const client = containerClient.getBlockBlobClient(blobName)
      await client.delete()
      console.log(`削除済み: ${blobName}`)
    }
  } catch (error) {
    console.error('削除エラー:', error.message)
    return res.send(`削除失敗\n${error.message}`)
  }

  res.redirect('/')
})

// POST: Likeカウントの更新
app.post('/like/:blobName', async (req, res) => {
  const blobName = req.params.blobName

  try {
    let entity
    try {
      entity = await tableClient.getEntity('Likes', blobName)
      entity.likes = parseInt(entity.likes) + 1
    } catch (error) {
      if (error.statusCode === 404) {
        entity = { partitionKey: 'Likes', rowKey: blobName, likes: 1 }
      } else {
        throw error
      }
    }

    await tableClient.upsertEntity(entity)
    res.json({ success: true, likes: entity.likes })
  } catch (error) {
    console.error('Like更新エラー:', error.message)
    res.status(500).json({ success: false, message: error.message })
  }
})

// サーバー起動
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ポート${PORT}で起動中`)
})
