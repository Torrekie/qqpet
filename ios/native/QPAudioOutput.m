#import "QPAudioOutput.h"
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <math.h>
#import <string.h>

static const double QPAudioRate = 44100;
static const NSUInteger QPAudioMaxContexts = 8;
static const NSUInteger QPAudioBufferCount = 4;
static const NSUInteger QPAudioMaxFrames = 16384;
static const NSUInteger QPAudioMaxGapFrames = 88200;
static const void *QPAudioQueueKey = &QPAudioQueueKey;

static BOOL QPAudioInteger(id value, double minimum, double maximum) {
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
    double number = [value doubleValue];
    return isfinite(number) && number >= minimum && number <= maximum && trunc(number) == number;
}

static BOOL QPAudioNumber(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() && isfinite([value doubleValue]);
}

@interface QPAudioBuffer : NSObject
@property(nonatomic) AudioQueueBufferRef buffer;
@property(nonatomic) BOOL enqueued;
@property(nonatomic) uint64_t source;
@property(nonatomic) double endTime;
@end
@implementation QPAudioBuffer
@end

@class QPAudioCallbackBox;

@interface QPAudioContext : NSObject
@property(nonatomic, copy) NSString *page;
@property(nonatomic, copy) NSString *key;
@property(nonatomic) uint64_t identifier;
@property(nonatomic) AudioQueueRef queue;
@property(nonatomic, strong) QPAudioCallbackBox *callbackBox;
@property(nonatomic, strong) NSMutableArray<QPAudioBuffer *> *buffers;
@property(nonatomic, copy) void (^reply)(NSDictionary *event);
@property(nonatomic) BOOL requestedRunning;
@property(nonatomic) BOOL running;
@property(nonatomic) BOOL interrupted;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL sessionLease;
@property(nonatomic) double time;
@property(nonatomic) double tail;
@property(nonatomic) uint64_t lastSource;
@end
@implementation QPAudioContext
@end

// The context retains this userData box until synchronous AudioQueueDispose
// returns. The box never owns either object that controls/disposes AudioQueue.
@interface QPAudioCallbackBox : NSObject
@property(nonatomic, weak) QPAudioOutput *owner;
@property(nonatomic, weak) QPAudioContext *context;
@property(nonatomic, strong) dispatch_queue_t controlQueue;
@end
@implementation QPAudioCallbackBox
@end

// AVAudioSession is shared by every host in this process. A running queue owns
// one lease; a paused/closed host must not deactivate another host's output.
// Access is serialized across instances by QPAudioOutput.class's monitor.
static NSUInteger QPAudioSessionLeases;
static BOOL QPAudioDeactivationPending;

static NSString *QPAudioReleaseSession(QPAudioContext *context) {
    @synchronized (QPAudioOutput.class) {
        BOOL released = context.sessionLease;
        if (released) {
            context.sessionLease = NO;
            if (QPAudioSessionLeases) QPAudioSessionLeases--;
        }
        if (QPAudioSessionLeases || (!released && !QPAudioDeactivationPending)) return nil;
        NSError *error = nil;
        QPAudioDeactivationPending = ![AVAudioSession.sharedInstance setActive:NO withOptions:0 error:&error];
        // A transient busy result is diagnostic only. The next lifecycle action
        // retries it; never spin or destroy otherwise valid paused contexts.
        return QPAudioDeactivationPending ? [NSString stringWithFormat:@"Audio session deactivation deferred: %@", error.localizedDescription ?: @"busy"] : nil;
    }
}

@interface QPAudioOutput ()
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) NSMutableDictionary<NSString *, QPAudioContext *> *contexts;
@property(nonatomic, strong) NSMutableArray *observers;
@property(nonatomic, copy) NSDictionary *snapshot;
@property(nonatomic) BOOL pausedByHost;
@property(nonatomic) BOOL invalidated;
@property(nonatomic) BOOL mediaServicesLost;
@property(nonatomic) uint64_t enqueued;
@property(nonatomic) uint64_t completed;
@property(nonatomic) uint64_t errors;
@property(nonatomic) uint64_t sanitized;
@property(nonatomic) uint64_t submittedFrames;
@property(nonatomic) uint64_t nonSilentBuffers;
@property(nonatomic, copy) NSString *lastError;
@property(nonatomic) NSTimeInterval lastErrorAt;
- (void)completedBuffer:(AudioQueueBufferRef)buffer queue:(AudioQueueRef)queue context:(QPAudioContext *)context;
@end

static void QPAudioOutputCallback(void *userData, AudioQueueRef queue, AudioQueueBufferRef buffer) {
    @autoreleasepool {
        QPAudioCallbackBox *box = (__bridge QPAudioCallbackBox *)userData;
        // Do not retain the output owner on AudioQueue's internal callback
        // thread: its final release could synchronously dispose the queue.
        // Only the box is retained until the control block checks its owners.
        dispatch_async(box.controlQueue, ^{
            QPAudioOutput *owner = box.owner;
            QPAudioContext *context = box.context;
            if (owner && context) [owner completedBuffer:buffer queue:queue context:context];
        });
    }
}

@implementation QPAudioOutput

- (instancetype)init {
    if (!(self = [super init])) return nil;
    _queue = dispatch_queue_create("net.ankio.qqpet.audio-output", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_queue, QPAudioQueueKey, (__bridge void *)self, NULL);
    _contexts = [NSMutableDictionary dictionary];
    _observers = [NSMutableArray array];
    _snapshot = @{@"contextCount":@0, @"queuedBuffers":@0, @"enqueuedBuffers":@0, @"completedBuffers":@0, @"errors":@0};
    __weak QPAudioOutput *weakSelf = self;
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    for (NSString *name in @[AVAudioSessionInterruptionNotification, AVAudioSessionRouteChangeNotification, AVAudioSessionMediaServicesWereLostNotification, AVAudioSessionMediaServicesWereResetNotification]) {
        id observer = [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *notification) {
            QPAudioOutput *output = weakSelf;
            if (!output) return;
            dispatch_async(output.queue, ^{ [output handleNotification:notification]; });
        }];
        [_observers addObject:observer];
    }
    [self updateStatus];
    return self;
}

- (void)dealloc {
    for (id observer in _observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
    // Do not capture or retain a deallocating self in a dispatch block.
    NSArray<QPAudioContext *> *contexts = _contexts.allValues;
    void (^dispose)(void) = ^{
        for (QPAudioContext *context in contexts) {
            context.closed = YES;
            context.running = NO;
            AudioQueueRef queue = context.queue;
            context.queue = NULL;
            if (queue) AudioQueueDispose(queue, true);
            context.callbackBox = nil;
            QPAudioReleaseSession(context);
        }
    };
    if (dispatch_get_specific(QPAudioQueueKey) == (__bridge void *)self) dispose();
    else dispatch_sync(_queue, dispose);
}

- (NSDictionary *)status {
    @synchronized (self) { return self.snapshot; }
}

- (void)updateStatus {
    NSUInteger queued = 0, running = 0;
    for (QPAudioContext *context in self.contexts.allValues) {
        if (context.running) running++;
        for (QPAudioBuffer *buffer in context.buffers) if (buffer.enqueued) queued++;
    }
    NSMutableDictionary *status = [@{@"contextCount":@(self.contexts.count), @"runningContexts":@(running), @"queuedBuffers":@(queued), @"enqueuedBuffers":@(self.enqueued), @"completedBuffers":@(self.completed), @"submittedFrames":@(self.submittedFrames), @"nonSilentBuffers":@(self.nonSilentBuffers), @"sanitizedSamples":@(self.sanitized), @"errors":@(self.errors), @"hostPaused":@(self.pausedByHost), @"mediaServicesLost":@(self.mediaServicesLost)} mutableCopy];
    @synchronized (QPAudioOutput.class) {
        status[@"sessionLeases"] = @(QPAudioSessionLeases);
        status[@"deactivationPending"] = @(QPAudioDeactivationPending);
    }
    if (self.lastError) {
        status[@"lastError"] = self.lastError;
        status[@"lastErrorAt"] = @(self.lastErrorAt);
    }
    @synchronized (self) { self.snapshot = status; }
}

- (void)recordError:(NSString *)error {
    self.errors++;
    self.lastError = error;
    self.lastErrorAt = NSDate.date.timeIntervalSince1970;
}

- (NSString *)state:(QPAudioContext *)context {
    return context.closed ? @"closed" : context.running ? @"running" : @"suspended";
}

- (double)currentTime:(QPAudioContext *)context {
    if (context.queue && context.running) {
        AudioTimeStamp stamp = {0};
        if (AudioQueueGetCurrentTime(context.queue, NULL, &stamp, NULL) == noErr && (stamp.mFlags & kAudioTimeStampSampleTimeValid) && isfinite(stamp.mSampleTime) && stamp.mSampleTime >= 0)
            context.time = MAX(context.time, stamp.mSampleTime / QPAudioRate);
    }
    return context.time;
}

- (NSMutableDictionary *)eventForContext:(QPAudioContext *)context type:(NSString *)type {
    return [@{@"page":context.page, @"context":@(context.identifier), @"type":type, @"time":@([self currentTime:context]), @"state":[self state:context]} mutableCopy];
}

- (void)emitState:(QPAudioContext *)context error:(NSString *)error {
    NSMutableDictionary *event = [self eventForContext:context type:@"state"];
    if (error) event[@"error"] = error;
    if (context.reply) context.reply(event);
}

- (NSString *)prepareAudio {
    NSError *error = nil;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    if ([session.category isEqualToString:AVAudioSessionCategoryAmbient] && [session.mode isEqualToString:AVAudioSessionModeDefault] && session.routeSharingPolicy == AVAudioSessionRouteSharingPolicyDefault) return nil;
    if (![session setCategory:AVAudioSessionCategoryAmbient mode:AVAudioSessionModeDefault routeSharingPolicy:AVAudioSessionRouteSharingPolicyDefault options:0 error:&error] || ![session.category isEqualToString:AVAudioSessionCategoryAmbient])
        return [NSString stringWithFormat:@"Ambient audio session: %@", error.localizedDescription ?: @"category verification failed"];
    return nil;
}

- (NSString *)pauseContext:(QPAudioContext *)context {
    if (!context.running || !context.queue) return nil;
    [self currentTime:context];
    OSStatus result = AudioQueuePause(context.queue);
    if (result != noErr) return [NSString stringWithFormat:@"AudioQueuePause: %d", (int)result];
    // Pause preserves both the queue timeline and unconsumed PCM. Capture its
    // final clock once, then leave it frozen until AudioQueueStart succeeds.
    [self currentTime:context];
    context.running = NO;
    NSString *deactivationError = QPAudioReleaseSession(context);
    if (deactivationError) [self recordError:deactivationError];
    return nil;
}

- (NSString *)startContext:(QPAudioContext *)context {
    if (context.closed || context.running || !context.requestedRunning || self.pausedByHost || context.interrupted) return nil;
    if (self.mediaServicesLost) return @"Audio media services are unavailable";
    @synchronized (QPAudioOutput.class) {
        NSString *error = [self prepareAudio];
        if (error) return error;
        NSError *activationError = nil;
        // Audio Queue Services requires explicit session reactivation following
        // an interruption. Ambient is verified before either activation or I/O.
        // https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/HandlingAudioInterruptions/HandlingAudioInterruptions.html
        if (![AVAudioSession.sharedInstance setActive:YES withOptions:0 error:&activationError])
            return [NSString stringWithFormat:@"Audio session activation: %@", activationError.localizedDescription ?: @"unavailable"];
        QPAudioDeactivationPending = NO;
        if (!context.sessionLease) { context.sessionLease = YES; QPAudioSessionLeases++; }
        OSStatus result = AudioQueueStart(context.queue, NULL);
        if (result != noErr) {
            NSString *deactivationError = QPAudioReleaseSession(context);
            if (deactivationError) [self recordError:deactivationError];
            return [NSString stringWithFormat:@"AudioQueueStart: %d", (int)result];
        }
    }
    context.running = YES;
    return nil;
}

- (void)disposeContext:(QPAudioContext *)context {
    [self currentTime:context];
    context.closed = YES;
    context.running = NO;
    context.requestedRunning = NO;
    // Mark the generation dead before disposal: callbacks forwarded from an
    // internal AudioQueue thread must not report successful ends after teardown.
    AudioQueueRef queue = context.queue;
    context.queue = NULL;
    if (queue) AudioQueueDispose(queue, true);
    // AudioQueue guarantees no further callbacks after Dispose returns when it
    // is called outside a callback. Keep userData alive through that boundary.
    context.callbackBox = nil;
    [context.buffers removeAllObjects];
    NSString *deactivationError = QPAudioReleaseSession(context);
    if (deactivationError) [self recordError:deactivationError];
}

- (void)completedBuffer:(AudioQueueBufferRef)buffer queue:(AudioQueueRef)queue context:(QPAudioContext *)context {
    if (!context || context.closed || context.queue != queue || self.contexts[context.key] != context) return;
    QPAudioBuffer *slot = nil;
    for (QPAudioBuffer *candidate in context.buffers) if (candidate.buffer == buffer) { slot = candidate; break; }
    if (!slot.enqueued) return;
    slot.enqueued = NO;
    uint64_t source = slot.source;
    self.completed++;
    NSMutableDictionary *event = [self eventForContext:context type:@"ended"];
    event[@"source"] = @(source);
    if (context.reply) context.reply(event);
    [self updateStatus];
}

- (NSString *)createQueue:(QPAudioContext *)context {
    NSString *error = [self prepareAudio];
    if (error) return error;
    AudioStreamBasicDescription format = {0};
    format.mSampleRate = QPAudioRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    format.mBytesPerPacket = 8;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = 8;
    format.mChannelsPerFrame = 2;
    format.mBitsPerChannel = 32;
    QPAudioCallbackBox *box = [QPAudioCallbackBox new];
    box.owner = self;
    box.context = context;
    box.controlQueue = self.queue;
    context.callbackBox = box;
    AudioQueueRef queue = NULL;
    // iOS 15's dispatch-queue AudioQueue implementation can destroy its client
    // on the callback queue and synchronously wait on that same queue. The
    // classic API's NULL run loop uses AudioQueue's own callback threads.
    OSStatus result = AudioQueueNewOutput(&format, QPAudioOutputCallback, (__bridge void *)box, NULL, NULL, 0, &queue);
    if (result != noErr || !queue) {
        if (queue) AudioQueueDispose(queue, true);
        context.callbackBox = nil;
        return [NSString stringWithFormat:@"AudioQueueNewOutput: %d", (int)result];
    }
    context.queue = queue;
    for (NSUInteger i = 0; i < QPAudioBufferCount; i++) {
        AudioQueueBufferRef buffer = NULL;
        result = AudioQueueAllocateBuffer(queue, (UInt32)((QPAudioMaxGapFrames + QPAudioMaxFrames) * 8), &buffer);
        if (result != noErr || !buffer) {
            [self disposeContext:context];
            return [NSString stringWithFormat:@"AudioQueueAllocateBuffer: %d", (int)result];
        }
        QPAudioBuffer *slot = [QPAudioBuffer new];
        slot.buffer = buffer;
        [context.buffers addObject:slot];
    }
    return nil;
}

- (NSString *)enqueue:(NSDictionary *)body context:(QPAudioContext *)context {
    if (!QPAudioInteger(body[@"source"], 1, 9007199254740991.0) || !QPAudioInteger(body[@"frames"], 1024, QPAudioMaxFrames) || !QPAudioInteger(body[@"sampleRate"], QPAudioRate, QPAudioRate) || !QPAudioInteger(body[@"channels"], 2, 2) || !QPAudioNumber(body[@"when"]) || [body[@"when"] doubleValue] < 0)
        return @"Invalid PCM metadata";
    NSNumber *source = body[@"source"];
    // IDs are monotonically increasing in the bridge, so lifetime uniqueness
    // requires one counter rather than an ever-growing history of PCM blocks.
    if (source.unsignedLongLongValue <= context.lastSource) return @"Audio source IDs must increase";
    QPAudioBuffer *slot = nil;
    for (QPAudioBuffer *candidate in context.buffers) if (!candidate.enqueued) { slot = candidate; break; }
    if (!slot) return @"Audio buffer limit exceeded";
    NSString *encoded = body[@"pcm"];
    NSUInteger frames = [body[@"frames"] unsignedIntegerValue];
    NSUInteger bytes = frames * 8;
    if (![encoded isKindOfClass:NSString.class] || encoded.length != ((bytes + 2) / 3) * 4) return @"Invalid PCM payload length";
    NSData *pcm = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
    if (pcm.length != bytes) return @"Invalid PCM payload";
    double start = MAX(context.tail, [self currentTime:context]);
    double gap = MAX(0, [body[@"when"] doubleValue] - start);
    if (gap > 2) return @"Audio scheduling gap exceeds two seconds";
    NSUInteger gapFrames = (NSUInteger)llround(gap * QPAudioRate);
    NSUInteger totalFrames = frames + gapFrames;
    memset(slot.buffer->mAudioData, 0, gapFrames * 8);
    float *destination = (float *)slot.buffer->mAudioData + gapFrames * 2;
    // The wire format is explicitly little-endian interleaved float32. Decode
    // its bits rather than assuming NSData's storage is float-aligned.
    const uint8_t *input = pcm.bytes;
    BOOL nonSilent = NO;
    for (NSUInteger i = 0; i < frames * 2; i++) {
        uint32_t bits = (uint32_t)input[i*4] | ((uint32_t)input[i*4+1] << 8) | ((uint32_t)input[i*4+2] << 16) | ((uint32_t)input[i*4+3] << 24);
        float sample;
        memcpy(&sample, &bits, sizeof(sample));
        if (!isfinite(sample)) { sample = 0; self.sanitized++; }
        if (sample != 0) nonSilent = YES;
        destination[i] = sample;
    }
    slot.buffer->mAudioDataByteSize = (UInt32)(totalFrames * 8);
    OSStatus result = AudioQueueEnqueueBuffer(context.queue, slot.buffer, 0, NULL);
    if (result != noErr) return [NSString stringWithFormat:@"AudioQueueEnqueueBuffer: %d", (int)result];
    slot.source = source.unsignedLongLongValue;
    slot.endTime = start + (double)totalFrames / QPAudioRate;
    slot.enqueued = YES;
    context.tail = slot.endTime;
    context.lastSource = source.unsignedLongLongValue;
    self.enqueued++;
    self.submittedFrames += frames;
    if (nonSilent) self.nonSilentBuffers++;
    return [self startContext:context];
}

- (void)handleMessage:(NSDictionary *)body reply:(void (^)(NSDictionary *event))reply {
    if (![body isKindOfClass:NSDictionary.class] || !reply) return;
    NSDictionary *message = [body copy];
    dispatch_async(self.queue, ^{
        NSString *page = message[@"page"], *operation = message[@"op"];
        if (![page isKindOfClass:NSString.class] || page.length == 0 || page.length > 80 || ![operation isKindOfClass:NSString.class] || !QPAudioInteger(message[@"context"], 1, 9007199254740991.0) || !QPAudioInteger(message[@"request"], 1, 9007199254740991.0)) {
            [self recordError:@"Invalid audio message"];
            [self updateStatus];
            return;
        }
        NSString *key = [NSString stringWithFormat:@"%lu:%@:%llu", (unsigned long)page.length, page, [message[@"context"] unsignedLongLongValue]];
        QPAudioContext *context = self.contexts[key];
        NSString *error = nil;
        if (self.invalidated) error = @"Audio output is closed";
        else if ([operation isEqualToString:@"create"]) {
            if (context) error = @"Audio context already exists";
            else if (self.contexts.count >= QPAudioMaxContexts) error = @"Audio context limit exceeded";
            else if (self.mediaServicesLost) error = @"Audio media services are unavailable";
            else if (!QPAudioInteger(message[@"sampleRate"], QPAudioRate, QPAudioRate) || !QPAudioInteger(message[@"channels"], 2, 2) || (message[@"format"] && ![message[@"format"] isEqual:@"f32"])) error = @"Unsupported audio format";
            else {
                context = [QPAudioContext new];
                context.page = page;
                context.identifier = [message[@"context"] unsignedLongLongValue];
                context.key = key;
                context.reply = reply;
                context.buffers = [NSMutableArray array];
                error = [self createQueue:context];
                if (!error) self.contexts[key] = context;
                else context.closed = YES;
            }
        } else if (!context) {
            if (![operation isEqualToString:@"close"]) error = @"Unknown audio context";
        } else if ([operation isEqualToString:@"enqueue"]) error = [self enqueue:message context:context];
        else if ([operation isEqualToString:@"resume"]) {
            context.requestedRunning = YES;
            context.interrupted = NO;
            error = [self startContext:context];
        } else if ([operation isEqualToString:@"suspend"]) {
            context.requestedRunning = NO;
            error = [self pauseContext:context];
        } else if ([operation isEqualToString:@"close"]) {
            [self disposeContext:context];
            [self.contexts removeObjectForKey:key];
        } else if (![operation isEqualToString:@"time"]) error = @"Unknown audio operation";
        NSMutableDictionary *event = context ? [self eventForContext:context type:@"reply"] : [@{@"page":page, @"context":message[@"context"], @"type":@"reply", @"time":@0, @"state":@"closed"} mutableCopy];
        event[@"request"] = message[@"request"];
        if (error) { event[@"error"] = error; [self recordError:error]; }
        reply(event);
        [self updateStatus];
    });
}

- (void)setHostPaused:(BOOL)paused {
    dispatch_async(self.queue, ^{
        if (self.invalidated || self.pausedByHost == paused) return;
        self.pausedByHost = paused;
        for (QPAudioContext *context in self.contexts.allValues) {
            NSString *error = paused ? [self pauseContext:context] : [self startContext:context];
            if (error) [self recordError:error];
            [self emitState:context error:error];
        }
        [self updateStatus];
    });
}

- (void)closeAll:(NSString *)error {
    NSArray<QPAudioContext *> *contexts = self.contexts.allValues;
    [self.contexts removeAllObjects];
    for (QPAudioContext *context in contexts) {
        [self disposeContext:context];
        [self emitState:context error:error];
        context.reply = nil;
    }
}

- (void)reset {
    dispatch_async(self.queue, ^{
        [self closeAll:nil];
        [self updateStatus];
    });
}

- (void)invalidate {
    void (^finish)(void) = ^{
        if (self.invalidated) return;
        self.invalidated = YES;
        [self closeAll:nil];
        for (id observer in self.observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
        [self.observers removeAllObjects];
        [self updateStatus];
    };
    if (dispatch_get_specific(QPAudioQueueKey) == (__bridge void *)self) finish();
    else dispatch_sync(self.queue, finish);
}

- (void)handleNotification:(NSNotification *)notification {
    if (self.invalidated) return;
    if ([notification.name isEqualToString:AVAudioSessionMediaServicesWereLostNotification] || [notification.name isEqualToString:AVAudioSessionMediaServicesWereResetNotification]) {
        self.mediaServicesLost = [notification.name isEqualToString:AVAudioSessionMediaServicesWereLostNotification];
        NSString *error = @"Audio media services reset; recreate the audio context";
        [self recordError:error];
        [self closeAll:error];
    } else if ([notification.name isEqualToString:AVAudioSessionInterruptionNotification]) {
        BOOL began = [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
        BOOL mayResume = ([notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume) != 0;
        for (QPAudioContext *context in self.contexts.allValues) {
            context.interrupted = began || !mayResume;
            NSString *error = began ? [self pauseContext:context] : [self startContext:context];
            if (error) [self recordError:error];
            [self emitState:context error:error];
        }
    } else if ([notification.name isEqualToString:AVAudioSessionRouteChangeNotification]) {
        BOOL removed = [notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;
        NSString *categoryError = removed || !self.contexts.count ? nil : [self prepareAudio];
        for (QPAudioContext *context in self.contexts.allValues) {
            NSString *error = categoryError;
            if (removed || error) {
                context.interrupted = YES;
                NSString *pauseError = [self pauseContext:context];
                if (!error) error = pauseError;
            }
            if (error) [self recordError:error];
            [self emitState:context error:error];
        }
    }
    [self updateStatus];
}

@end
