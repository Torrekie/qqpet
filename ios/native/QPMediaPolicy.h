#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN
// Configure before creating the WKWebView. The returned mode is diagnostic;
// system-default and gpu-fallback leave WebKit's original media path intact.
FOUNDATION_EXPORT NSString *QPConfigureMediaPreferences(WKPreferences *preferences);
NS_ASSUME_NONNULL_END
