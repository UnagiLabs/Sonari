use std::fs::File;
use std::io;
use std::os::fd::{FromRawFd, RawFd};

/// `AF_VSOCK` address family constant (not exposed by `libc` on all targets).
pub const AF_VSOCK: libc::c_int = 40;

/// Wildcard CID accepting connections from any context id.
pub const VMADDR_CID_ANY: u32 = 0xFFFF_FFFF;

/// `sockaddr_vm` layout used to bind a VSOCK listener.
#[repr(C)]
pub struct SockAddrVm {
    pub svm_family: libc::sa_family_t,
    pub svm_reserved1: u16,
    pub svm_port: u32,
    pub svm_cid: u32,
    pub svm_zero: [u8; 4],
}

impl SockAddrVm {
    /// Builds a wildcard-CID listen address bound to `port`.
    pub fn listen_any(port: u32) -> Self {
        Self {
            svm_family: AF_VSOCK as libc::sa_family_t,
            svm_reserved1: 0,
            svm_port: port,
            svm_cid: VMADDR_CID_ANY,
            svm_zero: [0; 4],
        }
    }
}

/// Owned VSOCK listening socket.
pub struct VsockListener {
    fd: RawFd,
}

impl VsockListener {
    /// Binds and listens on the given VSOCK `port` accepting any CID.
    pub fn bind(port: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let addr = SockAddrVm::listen_any(port);
        let bind_result = unsafe {
            libc::bind(
                fd,
                (&addr as *const SockAddrVm).cast::<libc::sockaddr>(),
                std::mem::size_of::<SockAddrVm>() as libc::socklen_t,
            )
        };
        if bind_result < 0 {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        let listen_result = unsafe { libc::listen(fd, 128) };
        if listen_result < 0 {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        Ok(Self { fd })
    }

    /// Accepts the next inbound connection as a blocking `File` stream.
    pub fn accept(&self) -> Result<File, Box<dyn std::error::Error>> {
        let fd = unsafe { libc::accept(self.fd, std::ptr::null_mut(), std::ptr::null_mut()) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

impl Drop for VsockListener {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AF_VSOCK, SockAddrVm, VMADDR_CID_ANY};

    #[test]
    fn listen_any_builds_wildcard_address_for_port() {
        let port = 3000;
        let addr = SockAddrVm::listen_any(port);

        assert_eq!(addr.svm_family, AF_VSOCK as libc::sa_family_t);
        assert_eq!(addr.svm_port, port);
        assert_eq!(addr.svm_cid, VMADDR_CID_ANY);
        assert_eq!(addr.svm_reserved1, 0);
        assert_eq!(addr.svm_zero, [0; 4]);
    }

    #[test]
    fn sockaddr_vm_layout_matches_kernel_expectation() {
        // The kernel expects a 16-byte sockaddr_vm header (family/reserved/port/cid)
        // followed by the zero padding. A regression here would silently break bind().
        assert_eq!(std::mem::size_of::<SockAddrVm>(), 16);
    }
}
