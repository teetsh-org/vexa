- **Authenticated bots: several identities, one concurrent bot each.** `BOT_EXTRA_IDENTITIES` lists
  further provisioned accounts (a JSON list of `{path, accessKey, secretKey}`, helm
  `meetingApi.botExtraIdentities`) beside `BOT_USERDATA_S3_PATH`. Each spawn takes the least recently
  used free identity, chosen in the meeting-row transaction under a deployment-wide lock; when all
  are held, `POST /bots` answers 409 naming the holders. `storage-init` creates and limits one scoped
  account per identity. See [Authenticated bots](/authenticated-bots).
