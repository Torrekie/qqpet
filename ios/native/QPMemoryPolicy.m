#import "QPMemoryPolicy.h"
#import <dlfcn.h>
#import <errno.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>

// Darwin 20/21 ABI; do not use the differently numbered current XNU bands.
// https://github.com/apple-oss-distributions/xnu/blob/xnu-7195.141.2/bsd/sys/kern_memorystatus.h
typedef struct { int32_t pid, priority; uint64_t user_data; int32_t limit; uint32_t state; } QPPriorityEntry;
typedef struct { int32_t priority; uint64_t user_data; } QPPriorityProperties;
// https://github.com/apple-oss-distributions/xnu/blob/xnu-7195.141.2/bsd/sys/proc_info.h
typedef struct {
    uint8_t uuid[16]; uint64_t unique, parentUnique; int32_t version;
    uint32_t reserved2; uint64_t reserved3, reserved4;
} QPProcessIdentity;
_Static_assert(sizeof(QPPriorityEntry)==24&&sizeof(QPPriorityProperties)==16&&sizeof(QPProcessIdentity)==56,"Unexpected Darwin process API ABI");
static int (*QPControl)(uint32_t,int32_t,uint32_t,void *,size_t);
static int (*QPProcessInfo)(int,int,uint64_t,void *,int);
enum { QPGetPriority=1, QPSetPriority=2, QPGetIdentity=17 };
static int32_t QPUIWorkerPriority=-1;

// Pinned WebKit SPI: Safari-610.1.28.1.9 / Safari-612.2.9.
@interface WKWebView (QPMemorySPI)
- (pid_t)_webProcessIdentifier;
@end
@interface WKProcessPool (QPMemorySPI)
- (pid_t)_gpuProcessIdentifier;
- (pid_t)_networkProcessIdentifier;
@end
@interface WKWebsiteDataStore (QPMemorySPI)
- (BOOL)_networkProcessExists;
- (pid_t)_networkProcessIdentifier;
@end

@interface QPMemoryLease : NSObject {
@public
    QPProcessIdentity identity;
    QPPriorityEntry original;
    uint64_t cookie;
    NSUInteger references;
}
@end
@implementation QPMemoryLease
@end

static NSMutableDictionary<NSString *,QPMemoryLease *> *QPLeases;
static BOOL QPSameIdentity(QPProcessIdentity a, QPProcessIdentity b) { return a.unique==b.unique&&a.version==b.version; }
static BOOL QPReadIdentity(pid_t pid, QPProcessIdentity *identity) {
    errno=0;
    return QPProcessInfo(pid,QPGetIdentity,0,identity,sizeof(*identity))==sizeof(*identity);
}
static BOOL QPReadPriority(pid_t pid, QPPriorityEntry *entry) {
    errno=0;
    return QPControl(QPGetPriority,pid,0,entry,sizeof(*entry))==sizeof(*entry)&&entry->pid==pid;
}
static NSDictionary *QPDiagnostic(NSString *state, pid_t pid) {
    int code=errno;
    return @{@"state":state,@"pid":@(pid),@"errno":@(code),@"message":code?[NSString stringWithUTF8String:strerror(code)]:@"Unexpected process API result"};
}
static NSDictionary *QPReleaseLease(NSString *key, QPMemoryLease *lease) {
    if (--lease->references) return @{@"pid":@(lease->original.pid),@"state":@"shared"};
    if (QPLeases[key]==lease) [QPLeases removeObjectForKey:key];
    pid_t pid=lease->original.pid;
    QPProcessIdentity identity;
    if (!QPReadIdentity(pid,&identity)) return QPDiagnostic(@"release-identity-unavailable",pid);
    if (!QPSameIdentity(identity,lease->identity)) return @{@"pid":@(pid),@"state":@"process-replaced"};
    QPPriorityEntry current;
    if (!QPReadPriority(pid,&current)) return QPDiagnostic(@"release-priority-unavailable",pid);
    // Another policy may have taken over. Never restore over its band or cookie.
    if (current.priority!=QPUIWorkerPriority||current.user_data!=lease->cookie)
        return @{@"pid":@(pid),@"state":@"superseded",@"priority":@(current.priority)};
    if (!QPReadIdentity(pid,&identity)||!QPSameIdentity(identity,lease->identity))
        return @{@"pid":@(pid),@"state":@"process-replaced"};
    QPPriorityProperties properties={lease->original.priority,lease->original.user_data};
    if (QPControl(QPSetPriority,pid,0,&properties,sizeof(properties))<0) return QPDiagnostic(@"restore-failed",pid);
    if (!QPReadPriority(pid,&current)) return QPDiagnostic(@"restore-unverified",pid);
    BOOL restored=current.priority==lease->original.priority&&current.user_data==lease->original.user_data;
    return @{@"pid":@(pid),@"state":restored?@"restored":@"restore-changed",@"priority":@(current.priority)};
}

@interface QPMemoryPolicy ()
@property(nonatomic,strong) NSMutableDictionary<NSString *,QPMemoryLease *> *leases;
@property(nonatomic) BOOL invalidated;
@end

@implementation QPMemoryPolicy
- (instancetype)init {
    if ((self=[super init])) {
        _leases=[NSMutableDictionary new];
        static dispatch_once_t once;
        dispatch_once(&once,^{
            NSInteger major=NSProcessInfo.processInfo.operatingSystemVersion.majorVersion;
            if (major==14||major==15) QPUIWorkerPriority=8;
            // Darwin 22 revised band numbering; the process structures are unchanged.
            // https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.81.2/bsd/sys/kern_memorystatus.h
            else if (major==16) QPUIWorkerPriority=80;
            QPControl=dlsym(RTLD_DEFAULT,"memorystatus_control");
            QPProcessInfo=dlsym(RTLD_DEFAULT,"proc_pidinfo");
            if (!QPProcessInfo) {
                void *handle=dlopen("/usr/lib/libproc.dylib",RTLD_LAZY|RTLD_LOCAL);
                if (handle) QPProcessInfo=dlsym(handle,"proc_pidinfo");
            }
            QPLeases=[NSMutableDictionary new];
        });
    }
    return self;
}
- (NSDictionary *)updateWithWebView:(WKWebView *)webView active:(BOOL)active {
    @synchronized(QPMemoryPolicy.class) {
        NSMutableArray *processes=[NSMutableArray new], *released=[NSMutableArray new];
        BOOL available=QPControl&&QPProcessInfo&&geteuid()==0&&QPUIWorkerPriority>=0;
        active=active&&!self.invalidated&&available;
        NSMutableDictionary<NSNumber *,NSMutableArray<NSString *> *> *pids=[NSMutableDictionary new];
        void (^add)(NSString *,pid_t,BOOL)=^(NSString *kind,pid_t pid,BOOL supported) {
            if (pid>0) {
                if (!pids[@(pid)]) pids[@(pid)]=[NSMutableArray new];
                [pids[@(pid)] addObject:kind];
            } else [processes addObject:@{@"kind":kind,@"state":supported?@"not-running":@"unsupported"}];
        };
        if (active) {
            BOOL supported=[webView respondsToSelector:@selector(_webProcessIdentifier)];
            add(@"web",supported?webView._webProcessIdentifier:0,supported);
            WKProcessPool *pool=webView.configuration.processPool;
            supported=[pool respondsToSelector:@selector(_gpuProcessIdentifier)];
            add(@"gpu",supported?pool._gpuProcessIdentifier:0,supported);
            WKWebsiteDataStore *store=webView.configuration.websiteDataStore;
            supported=[store respondsToSelector:@selector(_networkProcessIdentifier)]&&[store respondsToSelector:@selector(_networkProcessExists)];
            if (supported) add(@"network",store._networkProcessExists?store._networkProcessIdentifier:0,YES);
            else {
                supported=[pool respondsToSelector:@selector(_networkProcessIdentifier)];
                add(@"network",supported?pool._networkProcessIdentifier:0,supported);
            }
        }
        NSMutableSet<NSString *> *desired=[NSMutableSet new];
        for (NSNumber *number in [pids.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            pid_t pid=number.intValue;
            QPProcessIdentity identity;
            if (!QPReadIdentity(pid,&identity)) { [processes addObject:QPDiagnostic(@"identity-unavailable",pid)]; continue; }
            NSString *key=[NSString stringWithFormat:@"%d:%llu:%d",pid,(unsigned long long)identity.unique,identity.version];
            [desired addObject:key];
            QPPriorityEntry current;
            if (!QPReadPriority(pid,&current)) { [processes addObject:QPDiagnostic(@"priority-unavailable",pid)]; continue; }
            QPMemoryLease *lease=self.leases[key];
            if (lease&&(current.priority!=QPUIWorkerPriority||current.user_data!=lease->cookie)) {
                [self.leases removeObjectForKey:key];
                [released addObject:QPReleaseLease(key,lease)];
                lease=nil;
            }
            if (!lease) {
                QPMemoryLease *shared=QPLeases[key];
                if (shared&&current.priority==QPUIWorkerPriority&&current.user_data==shared->cookie) {
                    lease=shared; lease->references++; self.leases[key]=lease;
                } else if (current.priority==0) {
                    QPProcessIdentity checked;
                    if (!QPReadIdentity(pid,&checked)||!QPSameIdentity(identity,checked)) {
                        [processes addObject:QPDiagnostic(@"identity-changed",pid)]; continue;
                    }
                    QPPriorityEntry checkedPriority;
                    if (!QPReadPriority(pid,&checkedPriority)) { [processes addObject:QPDiagnostic(@"priority-unavailable",pid)]; continue; }
                    if (checkedPriority.priority!=0||checkedPriority.user_data!=current.user_data) {
                        [processes addObject:@{@"pid":number,@"state":@"priority-changed",@"priority":@(checkedPriority.priority)}]; continue;
                    }
                    lease=[QPMemoryLease new]; lease->identity=identity; lease->original=current; lease->references=1;
                    do { arc4random_buf(&lease->cookie,sizeof(lease->cookie)); } while (!lease->cookie);
                    QPPriorityProperties properties={QPUIWorkerPriority,lease->cookie};
                    if (QPControl(QPSetPriority,pid,0,&properties,sizeof(properties))<0) {
                        [processes addObject:QPDiagnostic(@"set-failed",pid)]; continue;
                    }
                    QPLeases[key]=lease; self.leases[key]=lease;
                    if (!QPReadPriority(pid,&current)) { [processes addObject:QPDiagnostic(@"set-unverified",pid)]; continue; }
                    if (!QPReadIdentity(pid,&checked)||!QPSameIdentity(identity,checked)) {
                        [processes addObject:QPDiagnostic(@"identity-changed",pid)]; continue;
                    }
                }
            }
            BOOL protected=lease&&current.priority==QPUIWorkerPriority&&current.user_data==lease->cookie;
            [processes addObject:@{@"pid":number,@"kinds":pids[number],@"state":protected?@"protected":@"unchanged",@"priority":@(current.priority)}];
        }
        for (NSString *key in self.leases.allKeys) if (![desired containsObject:key]) {
            QPMemoryLease *lease=self.leases[key]; [self.leases removeObjectForKey:key];
            [released addObject:QPReleaseLease(key,lease)];
        }
        NSMutableDictionary *result=[@{@"active":@(active),@"processes":processes,@"released":released} mutableCopy];
        if (!available) result[@"error"]=geteuid()!=0?@"Memory policy requires the root HUD":(QPUIWorkerPriority<0?@"Jetsam policy unavailable on this iOS version":@"Process memory APIs unavailable");
        if (self.invalidated) result[@"invalidated"]=@YES;
        return result;
    }
}
- (void)invalidate {
    @synchronized(QPMemoryPolicy.class) {
        if (self.invalidated) return;
        self.invalidated=YES;
        for (NSString *key in self.leases.allKeys) {
            NSDictionary *result=QPReleaseLease(key,self.leases[key]);
            if ([result[@"state"] containsString:@"failed"]||[result[@"state"] containsString:@"unavailable"]||[result[@"state"] containsString:@"unverified"])
                NSLog(@"QQPet memory policy release: %@",result);
        }
        [self.leases removeAllObjects];
    }
}
- (void)dealloc { [self invalidate]; }
@end
