class Bezl < Formula
  desc "Add device frames to device screen recordings"
  homepage "https://github.com/davidamunga/bezl"
  url "https://registry.npmjs.org/@damunga/bezl/-/bezl-0.0.3.tgz"
  sha256 "3a888189040c64ad4093c7b97d8d2b923f2cdfbdc4585226e9ccdcda35c17565"
  license "MIT"
  version "0.0.3"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["\#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("\#{bin}/bezl --version 2>&1")
  end
end
