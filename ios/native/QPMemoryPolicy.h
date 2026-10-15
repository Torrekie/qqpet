#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN
// Keeps only this view's active HUD workers out of the idle jetsam band.
// Call from the host's control loop; this object owns no timer or daemon.
@interface QPMemoryPolicy : NSObject
- (NSDictionary *)updateWithWebView:(WKWebView *)webView active:(BOOL)active;
- (void)invalidate;
@end
NS_ASSUME_NONNULL_END
