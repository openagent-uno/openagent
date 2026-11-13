Pod::Spec.new do |s|
  s.name         = 'IrohLib'
  s.version      = '0.35.0'
  s.summary      = 'iroh-ffi: QUIC P2P networking via iroh (wire-compatible with the OpenAgent server pin, iroh 0.35)'
  s.homepage     = 'https://github.com/n0-computer/iroh-ffi'
  s.license      = { :type => 'MIT OR Apache-2.0' }
  s.authors      = { 'n0 inc' => 'hello@n0.computer' }
  s.source       = { :http => 'https://github.com/n0-computer/iroh-ffi/releases/download/v0.35.0/IrohLib.xcframework.zip' }
  s.ios.deployment_target = '15.0'
  s.vendored_frameworks = 'Iroh.xcframework'
  s.static_framework = true
  s.frameworks = 'SystemConfiguration'
end
