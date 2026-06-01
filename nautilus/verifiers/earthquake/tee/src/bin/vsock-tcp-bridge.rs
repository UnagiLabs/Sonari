use clap::Parser;
use std::fs::File;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd};
use std::thread;

#[derive(Debug, Parser)]
#[command(about = "Bridge local TCP clients to a parent Nitro Enclave vsock service")]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    listen_host: String,
    #[arg(long, default_value_t = 18_080)]
    listen_port: u16,
    #[arg(long, default_value_t = 3)]
    parent_cid: u32,
    #[arg(long, default_value_t = 18_080)]
    vsock_port: u32,
}

fn main() -> io::Result<()> {
    let args = Args::parse();
    let listener = TcpListener::bind((args.listen_host.as_str(), args.listen_port))?;
    for incoming in listener.incoming() {
        match incoming {
            Ok(client) => {
                let parent_cid = args.parent_cid;
                let vsock_port = args.vsock_port;
                thread::spawn(move || {
                    if let Err(error) = bridge_connection(client, parent_cid, vsock_port) {
                        eprintln!("vsock-tcp-bridge connection failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("vsock-tcp-bridge accept failed: {error}"),
        }
    }
    Ok(())
}

fn bridge_connection(client: TcpStream, parent_cid: u32, vsock_port: u32) -> io::Result<()> {
    let vsock = connect_vsock(parent_cid, vsock_port)?;
    let mut client_to_vsock_reader = client.try_clone()?;
    let mut client_to_vsock_writer = vsock.try_clone()?;
    let client_to_vsock = thread::spawn(move || {
        let result = io::copy(&mut client_to_vsock_reader, &mut client_to_vsock_writer);
        let _ = shutdown_fd(client_to_vsock_writer.as_raw_fd(), libc::SHUT_WR);
        result
    });

    let mut vsock_to_client_reader = vsock;
    let mut vsock_to_client_writer = client;
    let vsock_to_client = io::copy(&mut vsock_to_client_reader, &mut vsock_to_client_writer);
    let _ = vsock_to_client_writer.shutdown(Shutdown::Write);
    join_copy(client_to_vsock)?;
    vsock_to_client?;
    Ok(())
}

fn join_copy(handle: thread::JoinHandle<io::Result<u64>>) -> io::Result<u64> {
    handle
        .join()
        .map_err(|_| io::Error::other("bridge copy thread panicked"))?
}

fn connect_vsock(cid: u32, port: u32) -> io::Result<File> {
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut address = unsafe { std::mem::zeroed::<libc::sockaddr_vm>() };
    address.svm_family = libc::AF_VSOCK as libc::sa_family_t;
    address.svm_port = port;
    address.svm_cid = cid;

    let result = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_vm).cast::<libc::sockaddr>(),
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(error);
    }

    Ok(unsafe { File::from_raw_fd(fd) })
}

fn shutdown_fd(fd: i32, how: i32) -> io::Result<()> {
    let result = unsafe { libc::shutdown(fd, how) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
