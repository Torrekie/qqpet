#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Owns native, mixable PCM output for the host's WebAudio bridge. Messages and
// state changes are serialized on a private control queue. Classic AudioQueue
// callbacks only forward asynchronously from AudioQueue's internal threads. The reply block must
// marshal UI work asynchronously; it is retained for completion events too.
@interface QPAudioOutput : NSObject
@property(nonatomic, readonly, copy) NSDictionary *status;
- (void)handleMessage:(NSDictionary *)body reply:(void (^)(NSDictionary *event))reply;
- (void)setHostPaused:(BOOL)paused;
- (void)reset;
- (void)invalidate;
@end

NS_ASSUME_NONNULL_END
