const fs = require("fs");
const { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
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

    // Every object of one report lives under "<BRAND>/<report id>/" (source, slides, thumbnails).
    // The prefix is built only from a brand read from the database and a numeric id, and removePrefix
    // refuses anything that does not look exactly like that, so it can never wipe a wider path.
    reportPrefix(brandKey, reportId) {
      const brand = String(brandKey || "");
      const id = Number(reportId);
      if (!brand || brand.includes("/") || brand.includes("..") || !Number.isInteger(id) || id <= 0) {
        throw new Error("invalid report storage prefix");
      }
      return `${brand}/${id}/`;
    },

    // Deletes everything under the prefix. Throws if S3 reports any object it could not delete, so
    // the caller never marks the files as gone when they are not.
    async removePrefix(prefix) {
      if (!/^[^/]+\/\d+\/$/.test(prefix) || prefix.includes("..")) {
        throw new Error("refusing to delete an unexpected prefix");
      }
      let token;
      let removed = 0;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
        if (keys.length) {
          const out = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
          if (out.Errors && out.Errors.length) {
            throw new Error(`could not delete ${out.Errors.length} object(s): ${out.Errors[0].Code}`);
          }
          removed += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return removed;
    },
  };
}

module.exports = { buildStorage };
