# AWS S3 Manager API

Simple Node v10 + Express v4 API for managing assets in an S3 bucket.

S3 config files must be present under `~/`.

To install, `nvm` is recommended. Tested with node v10.21.0.

```
npm i package.json

# debugging
node --inspect index.js
```

Once running, open Chrome tools at `chrome://inspect`.

### Note

When `NODE_ENV` is set to 'dev', the API proxies requests that don't match through to the React backend, which by default listens on port 3000.

