#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN
// Configure the private process pool and media preference before the WebView.
// Only webcontent permits iOS 15's guarded WebAudio constructor to run.
FOUNDATION_EXPORT NSString *QPConfigureMediaConfiguration(WKWebViewConfiguration *configuration);
NS_ASSUME_NONNULL_END
