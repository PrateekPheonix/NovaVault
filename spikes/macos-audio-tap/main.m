//
//  Phase 0 spike: macOS system-audio capture via Core Audio process taps.
//
//  Proves the single highest-risk assumption in the delivery plan: that we can hear the
//  *other* participant in a call (system audio) without a virtual audio driver and
//  without the Screen Recording permission that ScreenCaptureKit would demand.
//
//  Requires macOS 14.4+. Writes captured system audio to a WAV file.
//

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <AudioToolbox/AudioToolbox.h>

static void Fail(NSString *what, OSStatus err) {
    // OSStatus is often a four-char code; print both readings.
    char cc[5] = {0};
    uint32_t be = CFSwapInt32HostToBig((uint32_t)err);
    memcpy(cc, &be, 4);
    BOOL printable = YES;
    for (int i = 0; i < 4; i++) if (cc[i] < 32 || cc[i] > 126) printable = NO;
    if (printable) {
        fprintf(stderr, "FAIL: %s (OSStatus %d '%s')\n", what.UTF8String, (int)err, cc);
    } else {
        fprintf(stderr, "FAIL: %s (OSStatus %d)\n", what.UTF8String, (int)err);
    }
    exit(1);
}

static AudioObjectID DefaultOutputDevice(void) {
    AudioObjectID dev = kAudioObjectUnknown;
    UInt32 size = sizeof(dev);
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    OSStatus err = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &dev);
    if (err != noErr) Fail(@"read default output device", err);
    return dev;
}

static NSString *DeviceUID(AudioObjectID dev) {
    CFStringRef uid = NULL;
    UInt32 size = sizeof(uid);
    AudioObjectPropertyAddress addr = {
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    OSStatus err = AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &uid);
    if (err != noErr) Fail(@"read device UID", err);
    return CFBridgingRelease(uid);
}

int main(int argc, const char *argv[]) {
@autoreleasepool {
    double seconds   = (argc > 1) ? atof(argv[1]) : 10.0;
    NSString *outPath = (argc > 2) ? @(argv[2]) : @"capture.wav";

    printf("== Phase 0 spike: Core Audio process tap ==\n");
    printf("duration : %.1fs\n", seconds);
    printf("output   : %s\n\n", outPath.UTF8String);

    // ---- 1. Describe a global tap of all system audio -----------------------------
    // Excluding no processes = capture everything the machine plays.
    CATapDescription *desc =
        [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
    desc.name = @"InterviewCopilot Phase0 Spike";
    desc.UUID = [NSUUID UUID];
    desc.privateTap = YES;              // don't advertise this tap system-wide
    desc.muteBehavior = CATapUnmuted;   // CRITICAL: user must still hear the call

    AudioObjectID tapID = kAudioObjectUnknown;
    OSStatus err = AudioHardwareCreateProcessTap(desc, &tapID);
    if (err != noErr) {
        fprintf(stderr,
            "\nAudioHardwareCreateProcessTap failed.\n"
            "If this is a TCC denial, grant the calling app (Terminal/iTerm) permission under\n"
            "  System Settings > Privacy & Security > Screen & System Audio Recording\n"
            "and re-run.\n\n");
        Fail(@"AudioHardwareCreateProcessTap", err);
    }
    printf("[1/5] tap created            id=%u\n", (unsigned)tapID);

    // ---- 2. Read the tap's UID so the aggregate device can reference it -----------
    CFStringRef tapUIDRef = NULL;
    UInt32 size = sizeof(tapUIDRef);
    AudioObjectPropertyAddress uidAddr = {
        kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    err = AudioObjectGetPropertyData(tapID, &uidAddr, 0, NULL, &size, &tapUIDRef);
    if (err != noErr) Fail(@"read kAudioTapPropertyUID", err);
    NSString *tapUID = CFBridgingRelease(tapUIDRef);
    printf("[2/5] tap uid                %s\n", tapUID.UTF8String);

    // ---- 3. Build a private aggregate device wrapping the tap ---------------------
    AudioObjectID outputDev = DefaultOutputDevice();
    NSString *outputUID = DeviceUID(outputDev);
    NSString *aggUID = [NSString stringWithFormat:@"copilot-spike-%@", [NSUUID UUID].UUIDString];

    NSDictionary *aggDesc = @{
        @(kAudioAggregateDeviceNameKey):          @"InterviewCopilot Spike Aggregate",
        @(kAudioAggregateDeviceUIDKey):           aggUID,
        @(kAudioAggregateDeviceMainSubDeviceKey): outputUID,
        @(kAudioAggregateDeviceIsPrivateKey):     @YES,   // keep out of the user's device list
        @(kAudioAggregateDeviceIsStackedKey):     @NO,
        @(kAudioAggregateDeviceTapAutoStartKey):  @YES,
        @(kAudioAggregateDeviceSubDeviceListKey): @[ @{ @(kAudioSubDeviceUIDKey): outputUID } ],
        @(kAudioAggregateDeviceTapListKey):       @[ @{
            @(kAudioSubTapUIDKey):               tapUID,
            @(kAudioSubTapDriftCompensationKey): @YES,
        } ],
    };

    AudioObjectID aggID = kAudioObjectUnknown;
    err = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggDesc, &aggID);
    if (err != noErr) Fail(@"AudioHardwareCreateAggregateDevice", err);
    printf("[3/5] aggregate device       id=%u (main sub-device: %s)\n",
           (unsigned)aggID, outputUID.UTF8String);

    // ---- 4. Discover the capture format ------------------------------------------
    AudioStreamBasicDescription tapFormat = {0};
    size = sizeof(tapFormat);
    AudioObjectPropertyAddress fmtAddr = {
        kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain
    };
    err = AudioObjectGetPropertyData(aggID, &fmtAddr, 0, NULL, &size, &tapFormat);
    if (err != noErr) Fail(@"read aggregate input stream format", err);
    printf("[4/5] format                 %.0f Hz, %u ch, %u-bit%s\n",
           tapFormat.mSampleRate,
           (unsigned)tapFormat.mChannelsPerFrame,
           (unsigned)tapFormat.mBitsPerChannel,
           (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) ? " float" : "");

    // ---- 5. Open a WAV file; ExtAudioFile converts float->int16 for us ------------
    AudioStreamBasicDescription fileFormat = {0};
    fileFormat.mSampleRate       = tapFormat.mSampleRate;
    fileFormat.mFormatID         = kAudioFormatLinearPCM;
    fileFormat.mFormatFlags      = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
    fileFormat.mChannelsPerFrame = tapFormat.mChannelsPerFrame;
    fileFormat.mBitsPerChannel   = 16;
    fileFormat.mFramesPerPacket  = 1;
    fileFormat.mBytesPerFrame    = fileFormat.mChannelsPerFrame * 2;
    fileFormat.mBytesPerPacket   = fileFormat.mBytesPerFrame;

    NSURL *outURL = [NSURL fileURLWithPath:[outPath stringByExpandingTildeInPath]];
    ExtAudioFileRef file = NULL;
    err = ExtAudioFileCreateWithURL((__bridge CFURLRef)outURL, kAudioFileWAVEType,
                                    &fileFormat, NULL, kAudioFileFlags_EraseFile, &file);
    if (err != noErr) Fail(@"ExtAudioFileCreateWithURL", err);
    err = ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat,
                                  sizeof(tapFormat), &tapFormat);
    if (err != noErr) Fail(@"set ExtAudioFile client format", err);
    // Prime the async writer.
    err = ExtAudioFileWriteAsync(file, 0, NULL);
    if (err != noErr) Fail(@"prime ExtAudioFileWriteAsync", err);

    __block UInt64 framesWritten = 0;
    __block float  peak = 0.0f;        // per-tick, reset by the meter
    __block float  overallPeak = 0.0f; // whole run, never reset
    BOOL isFloat = (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;

    dispatch_queue_t q = dispatch_queue_create("copilot.spike.tap", DISPATCH_QUEUE_SERIAL);
    AudioDeviceIOProcID procID = NULL;
    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q,
        ^(const AudioTimeStamp *now, const AudioBufferList *inInput,
          const AudioTimeStamp *inInputTime, AudioBufferList *outOutput,
          const AudioTimeStamp *inOutputTime) {
            if (!inInput || inInput->mNumberBuffers == 0) return;

            UInt32 bytes = inInput->mBuffers[0].mDataByteSize;
            UInt32 frames = bytes / MAX(tapFormat.mBytesPerFrame, 1u);
            if (frames == 0) return;

            if (isFloat) {
                for (UInt32 b = 0; b < inInput->mNumberBuffers; b++) {
                    const float *s = (const float *)inInput->mBuffers[b].mData;
                    UInt32 n = inInput->mBuffers[b].mDataByteSize / sizeof(float);
                    for (UInt32 i = 0; i < n; i++) {
                        float a = fabsf(s[i]);
                        if (a > peak) peak = a;
                        if (a > overallPeak) overallPeak = a;
                    }
                }
            }
            OSStatus werr = ExtAudioFileWriteAsync(file, frames, inInput);
            if (werr == noErr) framesWritten += frames;
        });
    if (err != noErr) Fail(@"AudioDeviceCreateIOProcIDWithBlock", err);

    err = AudioDeviceStart(aggID, procID);
    if (err != noErr) Fail(@"AudioDeviceStart", err);
    printf("[5/5] capturing...           play audio now (a video, a call, anything)\n\n");

    // Level meter so you can see it working in real time.
    int ticks = (int)(seconds * 2);
    for (int i = 0; i < ticks; i++) {
        [NSThread sleepForTimeInterval:0.5];
        float p = peak; peak = 0.0f;
        int bars = (int)(fminf(p, 1.0f) * 40.0f);
        char meter[41]; memset(meter, '#', bars); meter[bars] = 0;
        printf("\r  %5.1fs  peak %6.1f dBFS |%-40s|",
               (i + 1) * 0.5, (p > 0 ? 20.0f * log10f(p) : -120.0f), meter);
        fflush(stdout);
    }
    printf("\n\n");

    // ---- teardown ----------------------------------------------------------------
    AudioDeviceStop(aggID, procID);
    AudioDeviceDestroyIOProcID(aggID, procID);
    ExtAudioFileDispose(file);
    AudioHardwareDestroyAggregateDevice(aggID);
    AudioHardwareDestroyProcessTap(tapID);

    double secsCaptured = tapFormat.mSampleRate > 0 ? framesWritten / tapFormat.mSampleRate : 0;
    printf("frames written : %llu (%.2fs of audio)\n", framesWritten, secsCaptured);
    printf("wav            : %s\n", outURL.path.UTF8String);

    printf("peak (run)     : %.1f dBFS\n", overallPeak > 0 ? 20.0f * log10f(overallPeak) : -120.0f);

    if (framesWritten == 0) {
        printf("\nRESULT: FAIL — tap created but delivered no frames.\n");
        return 2;
    }
    if (overallPeak == 0.0f) {
        // This is the important failure mode: Core Audio does NOT return an error when
        // audio-capture permission is missing. It hands back a correctly-formatted stream
        // of digital silence. Frame count alone is not proof of capture.
        printf("\nRESULT: INCONCLUSIVE — plumbing works, but every sample is silent.\n"
               "  %llu frames of correctly-formatted audio flowed, all zeros.\n"
               "\n"
               "  Most likely: the calling process lacks system-audio-recording permission.\n"
               "  Core Audio reports no error for this - it silently substitutes silence.\n"
               "\n"
               "  To verify: run this from Terminal.app, then grant Terminal under\n"
               "    System Settings > Privacy & Security > Screen & System Audio Recording\n"
               "  and re-run while audio is playing.\n"
               "\n"
               "  (If audio genuinely was playing and permission IS granted, that is a real\n"
               "   finding and the tap approach needs re-examination.)\n", framesWritten);
        return 3;
    }
    printf("\nRESULT: SUCCESS — real system audio captured, no virtual device needed.\n");
    return 0;
}
}
