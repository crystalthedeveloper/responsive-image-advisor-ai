# responsive-image-advisor-ai

AI tool that analyzes Webflow elements and recommends the perfect single image size for desktop and mobile to improve PageSpeed.

## Bundling and Deploying

1. Run `npm run bundle` to invoke `webflow extension bundle`. This packages the `/extension` directory into the ZIP Webflow expects.
2. Upload the generated ZIP through your Webflow App settings under **Designer Extension hosting**. Webflow hosts the assets on your `webflow-ext.com` domain and handles the `/__webflow` handshake.
3. Test exclusively via **Launch App** inside Webflow Designer; all development happens inside the hosted environment provided by Webflow.
