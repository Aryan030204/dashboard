const fs = require("fs");
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

// Private bucket only. Nothing here ever builds a URL for a browser; slides are streamed back
// through the API after authorization (PRD section 19).
function buildStorage(config) {
  if (!config.bucket) throw new Error("weekly-reports: WEEKLY_REPORTS_BUCKET must be set");
  const client = new S3Client({
    region: config.region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
  });
  const Bucket = config.bucket;

  async function streamToBuffer(body) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  return {
    sourceKey(brandKey, reportId, ext) {
      return `${brandKey}/${reportId}/source/presentation.${ext}`;
    },
    slideKey(brandKey, reportId, n) {
      return `${brandKey}/${reportId}/slides/${String(n).padStart(3, "0")}.webp`;
    },
    thumbKey(brandKey, reportId, n) {
      return `${brandKey}/${reportId}/thumbnails/${String(n).padStart(3, "0")}.webp`;
    },

    async putFile(key, filePath, contentType) {
      const upload = new Upload({
        client,
        params: { Bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType, ServerSideEncryption: "AES256" },
      });
      await upload.done();
    },

    async putBuffer(key, buffer, contentType) {
      const upload = new Upload({
        client,
        params: { Bucket, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: "AES256" },
      });
      await upload.done();
    },

    async getBuffer(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return streamToBuffer(out.Body);
    },

    async downloadToFile(key, destPath) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        out.Body.pipe(ws);
        out.Body.on("error", reject);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

module.exports = { buildStorage };
