#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Owns native, mixable PCM output for the host's WebAudio bridge. Messages and
// callbacks are serialized on a private queue. The reply block must marshal UI
// work asynchronously; it is also retained for that context's completion events.
@interface QPAudioOutput : NSObject
@property(nonatomic, readonly, copy) NSDictionary *status;
- (void)handleMessage:(NSDictionary *)body reply:(void (^)(NSDictionary *event))reply;
- (void)setHostPaused:(BOOL)paused;
- (void)reset;
- (void)invalidate;
@end

NS_ASSUME_NONNULL_END
