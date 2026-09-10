/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page, BrowserContext } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

/**
 * Camera test helpers for Playwright.
 *
 * Two strategies for injecting fake camera streams:
 *
 * 1. **Chromium flags** (most reliable) — use `chromiumFakeCameraArgs()` in
 *    playwright.config.ts to tell Chromium to use a fake device. You can
 *    optionally point it at a .y4m video file for specific test images.
 *
 * 2. **addInitScript** (more flexible) — use `injectFakeCamera()` to replace
 *    getUserMedia with a canvas-based stream. Supports injecting specific
 *    test images as the video feed.
 */

/**
 * Chromium launch args that enable a fake camera device.
 * Add these to your playwright.config.ts:
 *
 * ```ts
 * use: {
 *   launchOptions: {
 *     args: chromiumFakeCameraArgs(),
 *   },
 * }
 * ```
 *
 * Optionally provide a .y4m video file path to display a specific image.
 */
export function chromiumFakeCameraArgs(y4mFilePath?: string): string[] {
  const args = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ]
  if (y4mFilePath) {
    args.push(`--use-file-for-fake-video-capture=${y4mFilePath}`)
  }
  return args
}

/**
 * Inject a fake camera stream by replacing navigator.mediaDevices.getUserMedia.
 *
 * The fake stream is generated from a canvas that either:
 * - Displays a provided test image (base64 JPEG/PNG)
 * - Renders a solid color with a centered circle (default test pattern)
 *
 * Must be called BEFORE navigating to the page that requests camera access.
 *
 * Usage:
 *   await injectFakeCamera(page, {
 *     imageBase64: fs.readFileSync("test-data/bottle.jpg").toString("base64"),
 *   })
 *   await page.goto("/camera")
 */
export async function injectFakeCamera(
  page: Page,
  opts: {
    /** Base64-encoded image to display as the camera feed */
    imageBase64?: string
    /** Width of the fake video stream (default: 640) */
    width?: number
    /** Height of the fake video stream (default: 480) */
    height?: number
    /** Frame rate of the fake stream (default: 30) */
    fps?: number
  } = {},
) {
  const { width = 640, height = 480, fps = 30, imageBase64 } = opts

  await page.addInitScript(
    ({ w, h, fps, img }) => {
      // Create a persistent canvas for the fake video feed
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")!

      let streamReady: Promise<MediaStream>

      if (img) {
        // Load the test image and draw it to the canvas
        streamReady = new Promise((resolve) => {
          const image = new Image()
          image.onload = () => {
            // Draw the image to fill the canvas (cover behavior)
            const scale = Math.max(w / image.width, h / image.height)
            const sw = image.width * scale
            const sh = image.height * scale
            const sx = (w - sw) / 2
            const sy = (h - sh) / 2
            ctx.drawImage(image, sx, sy, sw, sh)
            resolve(canvas.captureStream(fps))
          }
          image.src = `data:image/jpeg;base64,${img}`
        })
      } else {
        // Default test pattern: dark background with a centered colored circle
        ctx.fillStyle = "#1a1a2e"
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = "#e2725b" // terracotta — easily identifiable in screenshots
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.2, 0, Math.PI * 2)
        ctx.fill()
        // Add a label so it's obvious this is a test feed
        ctx.fillStyle = "#ffffff"
        ctx.font = "16px monospace"
        ctx.textAlign = "center"
        ctx.fillText("TEST CAMERA", w / 2, h - 20)
        streamReady = Promise.resolve(canvas.captureStream(fps))
      }

      // Replace getUserMedia
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      )

      navigator.mediaDevices.getUserMedia = async (constraints) => {
        // Only intercept video requests
        if (constraints && (constraints as MediaStreamConstraints).video) {
          return streamReady
        }
        return originalGetUserMedia(constraints)
      }

      // Fake enumerateDevices to report a camera
      navigator.mediaDevices.enumerateDevices = async () =>
        [
          {
            deviceId: "fake-camera-device",
            groupId: "fake-group",
            kind: "videoinput" as MediaDeviceKind,
            label: "Test Camera (Fake)",
            toJSON() {
              return this
            },
          },
        ] as MediaDeviceInfo[]
    },
    { w: width, h: height, fps, img: imageBase64 },
  )
}

/**
 * Load a test image from the e2e fixtures directory and return its base64 content.
 *
 * Usage:
 *   const img = loadTestImage("bottle.jpg")
 *   await injectFakeCamera(page, { imageBase64: img })
 */
export function loadTestImage(filename: string): string {
  const fixturesDir = path.join(__dirname, "..", "fixtures")
  return fs.readFileSync(path.join(fixturesDir, filename)).toString("base64")
}

/**
 * Grant camera permissions for the browser context.
 * Call this in your test setup or playwright.config.ts.
 */
export async function grantCameraPermission(context: BrowserContext) {
  await context.grantPermissions(["camera"])
}

/**
 * Wait for the camera view component to be in streaming state.
 */
export async function waitForCameraStreaming(page: Page) {
  // Wait for the video element inside the camera-view to have a srcObject
  await page.waitForFunction(() => {
    const video = document.querySelector("[data-camera-view] video") as HTMLVideoElement
    return video && video.srcObject && video.readyState >= 2
  }, { timeout: 10_000 })
}

/**
 * Assert that a segmentation overlay canvas has non-empty content.
 * Use after triggering border detection to verify the segmentation mask was drawn.
 */
export async function assertSegmentationOverlayRendered(page: Page) {
  const hasContent = await page.evaluate(() => {
    const overlay = document.querySelector("[data-camera-overlay] canvas") as HTMLCanvasElement
    if (!overlay) return false
    const ctx = overlay.getContext("2d")
    if (!ctx) return false
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data
    // Check if any pixel has non-zero alpha
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) return true
    }
    return false
  })

  return hasContent
}
