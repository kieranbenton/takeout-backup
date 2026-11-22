# takeout-backup

Back up everything in your Google accounts (photos, videos, mail, Drive and the rest) to your own AWS S3 bucket and an external drive, using Google Takeout.

- **One command on your Mac.** It downloads your latest Takeout exports for you, resuming broken downloads.
- **Files stay as Takeout gives them.** Each export is unpacked onto your external drive, and only new files are uploaded to S3 Glacier Deep Archive (about $1 per TB per month).
- **Deleted files are kept for a year** before they leave the backup.
- **Restoring doesn't need this tool:** the bucket is plain folders and files.

**Status:** design stage. See [docs/design.md](docs/design.md). There's no code yet.

## License

[MIT](LICENSE)
