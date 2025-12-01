# responsive-image-advisor-ai

AI tool that analyzes Webflow elements and recommends the perfect single image size for desktop and mobile to improve PageSpeed.

## Bundling and Deploying

1. Run `npm run bundle` to invoke `webflow extension bundle`. This packages the `/extension` directory into the ZIP Webflow expects.
2. Upload the generated ZIP through your Webflow App settings under **Designer Extension hosting**. Webflow will host the assets on your `webflow-ext.com` domain and handle the `/__webflow` handshake.
3. Test exclusively via **Launch App** inside Webflow Designer; Designer Extensions can no longer run from localhost or other custom dev servers.
