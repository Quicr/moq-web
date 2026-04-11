# Android Video Conferencing: Aspect Ratio Handling with H264

A comprehensive guide to handling video dimensions and aspect ratio through the complete video pipeline in an Android conferencing application.

---

## The Complete Pipeline

```
Camera2 Capture --> MediaCodec Encoder --> MediaCodec Decoder --> SurfaceView/TextureView
     1080p             H264 NALUs            YUV/RGB frames           Display
   (varies)          (dimensions in SPS)                             (varies)
```

---

## 1. Capture: Camera2 API

### Resolution Selection

```kotlin
// Get available output sizes for the camera
val characteristics = cameraManager.getCameraCharacteristics(cameraId)
val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
val outputSizes = map?.getOutputSizes(SurfaceTexture::class.java)

// Find best match for 1080p (could be 1920x1080 or 1080x1920)
fun selectOptimalSize(
    choices: Array<Size>,
    targetWidth: Int,
    targetHeight: Int
): Size {
    // Filter sizes that match aspect ratio
    val targetRatio = targetWidth.toFloat() / targetHeight
    
    return choices
        .filter { 
            val ratio = it.width.toFloat() / it.height
            abs(ratio - targetRatio) < 0.01  // ~1% tolerance
        }
        .minByOrNull { 
            abs(it.width * it.height - targetWidth * targetHeight) 
        } ?: choices[0]
}
```

### Handle Device Rotation

```kotlin
// Camera sensor orientation vs device orientation
val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
val deviceRotation = windowManager.defaultDisplay.rotation

// Calculate rotation needed
val rotation = when (deviceRotation) {
    Surface.ROTATION_0 -> sensorOrientation
    Surface.ROTATION_90 -> (sensorOrientation + 270) % 360
    Surface.ROTATION_180 -> (sensorOrientation + 180) % 360
    Surface.ROTATION_270 -> (sensorOrientation + 90) % 360
    else -> sensorOrientation
}

// IMPORTANT: Store this rotation - you'll need to signal it to receivers
captureRequestBuilder.set(CaptureRequest.JPEG_ORIENTATION, rotation)
```

### Key Point: Camera Always Outputs in Sensor Orientation

| Scenario | Output | Note |
|----------|--------|------|
| Physical sensor | Landscape (1920x1080) | Fixed hardware orientation |
| Phone held portrait | 1920x1080 rotated 90 degrees | Must rotate before encode OR signal rotation |
| Phone held landscape | 1920x1080 native | No rotation needed |

---

## 2. Encode: MediaCodec H264

### Encoder Setup

```kotlin
fun createEncoder(width: Int, height: Int, frameRate: Int, bitrate: Int): MediaCodec {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, 
            MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)  // For Surface input
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)  // GOP size
        
        // CRITICAL: These are encoded in SPS/PPS
        // width and height here define the encoded dimensions
    }
    
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    
    return encoder
}
```

### Where Dimensions Live in H264

The H264 bitstream contains dimension information in the SPS (Sequence Parameter Set):

| Field | Purpose |
|-------|---------|
| `pic_width_in_mbs_minus1` | Width = (value + 1) * 16 |
| `pic_height_in_map_units_minus1` | Height calculation |
| `frame_cropping_flag` | Exact dimensions if not multiple of 16 |
| `vui_parameters_present_flag` | Contains aspect ratio info |
| `aspect_ratio_idc` | SAR (Sample Aspect Ratio) |

### Signaling Rotation: Two Approaches

**Approach A: Transform before encoding (recommended for compatibility)**

```kotlin
// Use OpenGL to rotate the camera texture before feeding to encoder
// This way encoded video is "correct" orientation
// Width/height swap if rotating 90/270

val isPortrait = rotation == 90 || rotation == 270
val encodedWidth = if (isPortrait) 1080 else 1920
val encodedHeight = if (isPortrait) 1920 else 1080

// GPU shader rotates the texture
// Encoder receives already-rotated frames
```

**Approach B: Signal rotation out-of-band**

```kotlin
// Encode in sensor orientation (always landscape)
// Send rotation as metadata alongside the stream

data class VideoTrackMetadata(
    val width: Int,           // 1920
    val height: Int,          // 1080
    val rotation: Int,        // 90 (for portrait)
    val pixelAspectRatio: Float  // 1.0 (square pixels)
)

// In SDP, WebRTC, or MoQ metadata
// Receiver must apply rotation during render
```

---

## 3. Decode: MediaCodec H264

### Decoder Setup

```kotlin
fun createDecoder(width: Int, height: Int, surface: Surface): MediaCodec {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
    
    val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    
    // Output directly to Surface for efficient rendering
    decoder.configure(format, surface, null, 0)
    
    return decoder
}
```

### Handling Format Changes

```kotlin
// Decoder may signal format change when SPS is parsed
when (val outputBufferIndex = decoder.dequeueOutputBuffer(bufferInfo, timeoutUs)) {
    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
        val newFormat = decoder.outputFormat
        val actualWidth = newFormat.getInteger(MediaFormat.KEY_WIDTH)
        val actualHeight = newFormat.getInteger(MediaFormat.KEY_HEIGHT)
        
        // IMPORTANT: Update your rendering surface/view with actual dimensions
        // These may differ from what you initially configured
        onVideoSizeChanged(actualWidth, actualHeight)
    }
    // ... handle frames
}
```

### Key Point: Decoder Discovers Dimensions from Bitstream

| Step | What Happens |
|------|--------------|
| Configure | You provide "expected" width/height |
| Parse SPS | Actual dimensions extracted from bitstream |
| Format Change | `INFO_OUTPUT_FORMAT_CHANGED` signals actual size |
| Action | Always listen and update your view accordingly |

---

## 4. Render: SurfaceView / TextureView

### Option A: SurfaceView with Aspect Ratio Container

```kotlin
class AspectRatioFrameLayout @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : FrameLayout(context, attrs) {
    
    private var videoWidth = 0
    private var videoHeight = 0
    private var rotation = 0
    private var scaleType = ScaleType.FIT  // or FILL
    
    enum class ScaleType { FIT, FILL }
    
    fun setVideoSize(width: Int, height: Int, rotation: Int = 0) {
        // Account for rotation
        if (rotation == 90 || rotation == 270) {
            this.videoWidth = height
            this.videoHeight = width
        } else {
            this.videoWidth = width
            this.videoHeight = height
        }
        this.rotation = rotation
        requestLayout()
    }
    
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        
        if (videoWidth == 0 || videoHeight == 0) return
        
        val containerWidth = measuredWidth.toFloat()
        val containerHeight = measuredHeight.toFloat()
        
        val videoAspect = videoWidth.toFloat() / videoHeight
        val containerAspect = containerWidth / containerHeight
        
        val (targetWidth, targetHeight) = when (scaleType) {
            ScaleType.FIT -> {
                // Letterbox/pillarbox - show all content
                if (videoAspect > containerAspect) {
                    // Video is wider - fit to width, letterbox top/bottom
                    containerWidth to (containerWidth / videoAspect)
                } else {
                    // Video is taller - fit to height, pillarbox sides
                    (containerHeight * videoAspect) to containerHeight
                }
            }
            ScaleType.FILL -> {
                // Crop - fill container, lose edges
                if (videoAspect > containerAspect) {
                    // Video is wider - fit to height, crop sides
                    (containerHeight * videoAspect) to containerHeight
                } else {
                    // Video is taller - fit to width, crop top/bottom
                    containerWidth to (containerWidth / videoAspect)
                }
            }
        }
        
        // Measure child (SurfaceView) with calculated dimensions
        val childWidthSpec = MeasureSpec.makeMeasureSpec(targetWidth.toInt(), MeasureSpec.EXACTLY)
        val childHeightSpec = MeasureSpec.makeMeasureSpec(targetHeight.toInt(), MeasureSpec.EXACTLY)
        
        getChildAt(0)?.measure(childWidthSpec, childHeightSpec)
    }
    
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val child = getChildAt(0) ?: return
        
        // Center the child
        val childWidth = child.measuredWidth
        val childHeight = child.measuredHeight
        val left = (measuredWidth - childWidth) / 2
        val top = (measuredHeight - childHeight) / 2
        
        child.layout(left, top, left + childWidth, top + childHeight)
    }
}
```

### Option B: TextureView with Matrix Transform

```kotlin
class VideoTextureView(context: Context) : TextureView(context) {
    
    private var videoWidth = 0
    private var videoHeight = 0
    private var videoRotation = 0
    
    fun setVideoSize(width: Int, height: Int, rotation: Int = 0) {
        videoWidth = width
        videoHeight = height
        videoRotation = rotation
        updateTransform()
    }
    
    private fun updateTransform() {
        if (videoWidth == 0 || videoHeight == 0 || width == 0 || height == 0) return
        
        val matrix = Matrix()
        
        val viewWidth = width.toFloat()
        val viewHeight = height.toFloat()
        
        // Account for rotation in aspect ratio calculation
        val (effectiveVideoWidth, effectiveVideoHeight) = if (videoRotation == 90 || videoRotation == 270) {
            videoHeight.toFloat() to videoWidth.toFloat()
        } else {
            videoWidth.toFloat() to videoHeight.toFloat()
        }
        
        val videoAspect = effectiveVideoWidth / effectiveVideoHeight
        val viewAspect = viewWidth / viewHeight
        
        // Calculate scale for aspect-fit
        val (scaleX, scaleY) = if (videoAspect > viewAspect) {
            1f to (viewAspect / videoAspect)
        } else {
            (videoAspect / viewAspect) to 1f
        }
        
        // Apply transformations centered
        matrix.setScale(scaleX, scaleY, viewWidth / 2, viewHeight / 2)
        
        // Apply rotation if needed (if not pre-rotated during encoding)
        if (videoRotation != 0) {
            matrix.postRotate(videoRotation.toFloat(), viewWidth / 2, viewHeight / 2)
        }
        
        setTransform(matrix)
    }
    
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateTransform()
    }
}
```

---

## 5. Grid Layout: Multiple Participants

```kotlin
class VideoGridLayout(context: Context) : ViewGroup(context) {
    
    private var participantCount = 0
    
    fun setParticipantCount(count: Int) {
        participantCount = count
        requestLayout()
    }
    
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val width = r - l
        val height = b - t
        
        val columns = ceil(sqrt(participantCount.toDouble())).toInt()
        val rows = ceil(participantCount.toDouble() / columns).toInt()
        
        val cellWidth = width / columns
        val cellHeight = height / rows
        
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val row = i / columns
            val col = i % columns
            
            val left = col * cellWidth
            val top = row * cellHeight
            
            // Each child is an AspectRatioFrameLayout containing a SurfaceView
            // The aspect ratio handling happens inside each child
            child.layout(left, top, left + cellWidth, top + cellHeight)
        }
    }
    
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Measure children to fill their cells
        // Each AspectRatioFrameLayout will handle aspect ratio internally
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
```

---

## 6. Complete Flow Example

```kotlin
class VideoConferenceManager(
    private val context: Context
) {
    // Capture
    private lateinit var cameraDevice: CameraDevice
    private lateinit var captureSession: CameraCaptureSession
    
    // Encode
    private lateinit var encoder: MediaCodec
    private var encodedWidth = 1920
    private var encodedHeight = 1080
    private var captureRotation = 0
    
    // Track metadata to send to remote
    data class LocalVideoTrack(
        val width: Int,
        val height: Int,
        val rotation: Int,  // 0, 90, 180, 270
        val codec: String = "H264"
    )
    
    fun startCapture(previewSurface: Surface) {
        // 1. Open camera
        // 2. Determine rotation
        captureRotation = calculateRotation()
        
        // 3. Create encoder (in sensor orientation)
        encoder = createEncoder(1920, 1080, 30, 2_000_000)
        val encoderSurface = encoder.createInputSurface()
        encoder.start()
        
        // 4. Setup capture session with both preview and encoder surfaces
        val surfaces = listOf(previewSurface, encoderSurface)
        cameraDevice.createCaptureSession(surfaces, /* callback */)
        
        // 5. Signal track metadata to remote participants
        sendTrackMetadata(LocalVideoTrack(
            width = encodedWidth,
            height = encodedHeight,
            rotation = captureRotation
        ))
    }
    
    // On receive side
    fun onRemoteTrackReceived(
        trackMetadata: LocalVideoTrack,
        videoView: AspectRatioFrameLayout
    ) {
        // Decoder outputs to the SurfaceView inside videoView
        val surfaceView = videoView.getChildAt(0) as SurfaceView
        
        decoder = createDecoder(
            trackMetadata.width,
            trackMetadata.height,
            surfaceView.holder.surface
        )
        decoder.start()
        
        // Tell the view about dimensions + rotation
        videoView.setVideoSize(
            trackMetadata.width,
            trackMetadata.height,
            trackMetadata.rotation
        )
    }
}
```

---

## 7. Summary: Where Aspect Ratio is Handled

| Stage | What Happens | Your Responsibility |
|-------|--------------|---------------------|
| **Capture** | Camera outputs in sensor orientation | Select resolution, track rotation |
| **Encode** | Dimensions baked into SPS | Decide: rotate before encode OR signal rotation |
| **Transport** | Bitstream + metadata | Signal width, height, rotation to receiver |
| **Decode** | Reads dimensions from SPS | Listen for format changes |
| **Render** | Must fit video into arbitrary container | Implement aspect ratio layout (FIT/FILL) |

### The Golden Rule

**Never assume sender and receiver have same screen dimensions.**

- Always signal video dimensions + rotation
- Always calculate aspect ratio at render time
- Handle `INFO_OUTPUT_FORMAT_CHANGED` from decoder

---

## 8. Comparison: FIT vs FILL

| Mode | Behavior | Use Case |
|------|----------|----------|
| **FIT (Letterbox)** | Shows all content, may have black bars | Default safe choice, no content loss |
| **FILL (Crop)** | Fills container, clips edges | More immersive, loses edge content |

### Visual Example

```
Portrait video (9:16) on Landscape screen (16:9):

FIT:                          FILL:
+--+--------+--+              +----------------+
|  |        |  |              |    clipped     |
|  | video  |  |              |================|
|  |        |  |              |     video      |
|  |        |  |              |================|
|  |        |  |              |    clipped     |
+--+--------+--+              +----------------+
   pillarbox                     edges cropped
```

---

## 9. Best Practices

1. **Capture**: Always track sensor orientation and device rotation
2. **Encode**: Prefer GPU rotation before encode for maximum compatibility
3. **Metadata**: Signal width, height, rotation, and codec in track metadata
4. **Decode**: Always handle `INFO_OUTPUT_FORMAT_CHANGED`
5. **Render**: Use `AspectRatioFrameLayout` or `TextureView` with matrix transforms
6. **Grid**: Let each participant tile handle its own aspect ratio internally
