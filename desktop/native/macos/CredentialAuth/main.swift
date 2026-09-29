import Foundation
import LocalAuthentication

// A tiny native verifier for Settings › 电脑操作 › 凭据 › 查看. It receives no
// credential bytes and prints none. Main decrypts only after exit status 0.
let context = LAContext()
context.localizedCancelTitle = "取消"
let reason = "查看保存在 Emperor Agent 中的凭据"
var policyError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
    exit(2)
}
let done = DispatchSemaphore(value: 0)
var authorized = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
    authorized = success
    done.signal()
}
if done.wait(timeout: .now() + .seconds(90)) == .timedOut {
    exit(3)
}
exit(authorized ? 0 : 1)
